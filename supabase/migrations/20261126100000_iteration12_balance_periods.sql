-- Итерация 12 (шаг 5б, docs/ANCHORS.md): таблица периодов остатков balance_periods. Бизнес-правил здесь нет, только хранилище.
-- 1) таблица balance_periods (загруженная выписка или ручная фиксация: период, остаток на начало и конец),
-- 2) один действующий период на (счёт, начало, конец), RLS как у контрольных точек (can_read / can_write по счёту),
-- 3) apply_batch знает таблицу balance_periods. Данные не переносятся (перенос начальных остатков вместе с новым расчётом, шаг 5в).
-- Применять в SQL Editor: сначала тестовый проект, потом рабочий. Безопасна для повторного запуска.

create table if not exists public.balance_periods (
  id uuid primary key,
  account_id uuid not null references public.accounts(id) on delete restrict,
  period_start date not null,
  period_end date not null,
  opening_balance numeric(18,2) not null,
  closing_balance numeric(18,2) not null,
  source text not null default 'statement' check (source in ('statement', 'manual')),
  ref text,
  status text not null default 'active' check (status in ('active', 'invalid')),
  note text,
  created_by uuid,
  created_at timestamptz not null default now(),
  constraint balance_periods_range check (period_end >= period_start)
);
create unique index if not exists uq_balance_periods_active on public.balance_periods (account_id, period_start, period_end) where status = 'active';
create index if not exists idx_balance_periods_account on public.balance_periods (account_id, period_start);

alter table public.balance_periods enable row level security;
drop policy if exists bp_select on public.balance_periods;
drop policy if exists bp_insert on public.balance_periods;
drop policy if exists bp_update on public.balance_periods;
create policy bp_select on public.balance_periods for select to authenticated using ((select app_private.can_read(account_id)));
create policy bp_insert on public.balance_periods for insert to authenticated with check ((select app_private.can_write(account_id)));
create policy bp_update on public.balance_periods for update to authenticated
  using ((select app_private.can_write(account_id))) with check ((select app_private.can_write(account_id)));
revoke all on public.balance_periods from anon;
grant select, insert, update on public.balance_periods to authenticated;

-- ---------- Записать пакет: добавлена таблица balance_periods ----------
create or replace function public.apply_batch(p jsonb)
returns void
language plpgsql
security invoker
set search_path = public, pg_temp
as $fn$
declare
  v_tables constant text[] := array[
    'app_settings', 'plan_types', 'countries', 'currencies', 'institutions', 'projects', 'accounts',
    'account_access', 'account_identifiers', 'tag_groups', 'tags', 'counterparties', 'counterparty_identifiers',
    'transactions', 'balance_checkpoints', 'period_locks', 'fx_rates', 'fx_source_priority', 'import_jobs', 'statement_tasks', 'statement_problems', 'balance_periods'];
  v_pks constant text[] := array[
    'key', 'key', 'key', 'key', 'id', 'id', 'id',
    'account_id,user_id', 'id', 'id', 'id', 'id', 'id',
    'id', 'id', 'id', 'id', 'source', 'id', 'id', 'id', 'id'];
  i int;
  t text;
  pk text;
  v_pk_cols text[];
  v_rows jsonb;
  v_cols text;
  v_set text;
begin
  if p is null or jsonb_typeof(p) <> 'object' then
    raise exception 'BATCH: ожидается объект jsonb';
  end if;

  if jsonb_typeof(p -> 'delete_transaction_ids') = 'array' and jsonb_array_length(p -> 'delete_transaction_ids') > 0 then
    delete from public.transactions
    where id in (select (e)::uuid from jsonb_array_elements_text(p -> 'delete_transaction_ids') as e);
  end if;

  if jsonb_typeof(p -> 'delete_problem_task_ids') = 'array' and jsonb_array_length(p -> 'delete_problem_task_ids') > 0 then
    delete from public.statement_problems
    where task_id in (select (e)::uuid from jsonb_array_elements_text(p -> 'delete_problem_task_ids') as e);
  end if;

  for i in 1 .. array_length(v_tables, 1) loop
    t := v_tables[i];
    pk := v_pks[i];
    v_pk_cols := string_to_array(pk, ',');
    v_rows := p -> 'put' -> t;
    if v_rows is null or jsonb_typeof(v_rows) <> 'array' or jsonb_array_length(v_rows) = 0 then
      continue;
    end if;

    select string_agg(quote_ident(a.attname), ', ' order by a.attnum),
           string_agg(quote_ident(a.attname), ', ' order by a.attnum) filter (where a.attname <> all (v_pk_cols))
      into v_cols, v_set
    from pg_attribute a
    where a.attrelid = format('public.%I', t)::regclass
      and a.attnum > 0 and not a.attisdropped
      and (v_rows -> 0) ? a.attname;

    if v_cols is null or exists (select 1 from unnest(v_pk_cols) c where not ((v_rows -> 0) ? c)) then
      raise exception 'BATCH: в таблице % нет ключа %', t, pk;
    end if;

    -- Сначала вставка новых строк, затем обновление существующих. Конструкция ON CONFLICT не годится:
    -- она заставляет новую строку сразу проходить политику чтения, а счёт получает доступ владельца
    -- только позже в том же пакете.
    execute format(
      'insert into public.%1$I (%2$s) select %3$s from jsonb_populate_recordset(null::public.%1$I, $1) as e '
      'where not exists (select 1 from public.%1$I as x where %4$s)',
      t, v_cols,
      (select string_agg('e.' || quote_ident(a.attname), ', ' order by a.attnum)
         from pg_attribute a
        where a.attrelid = format('public.%I', t)::regclass and a.attnum > 0 and not a.attisdropped
          and (v_rows -> 0) ? a.attname),
      (select string_agg('x.' || quote_ident(c) || ' = e.' || quote_ident(c), ' and ') from unnest(v_pk_cols) c))
      using v_rows;
    if v_set is not null then
      execute format(
        'update public.%1$I as t set %2$s from jsonb_populate_recordset(null::public.%1$I, $1) as e where %3$s',
        t,
        (select string_agg(quote_ident(a.attname) || ' = e.' || quote_ident(a.attname), ', ' order by a.attnum)
           from pg_attribute a
          where a.attrelid = format('public.%I', t)::regclass and a.attnum > 0 and not a.attisdropped
            and (v_rows -> 0) ? a.attname and a.attname <> all (v_pk_cols)),
        (select string_agg('t.' || quote_ident(c) || ' = e.' || quote_ident(c), ' and ') from unnest(v_pk_cols) c))
        using v_rows;
    end if;
  end loop;

  if jsonb_typeof(p -> 'audit') = 'array' and jsonb_array_length(p -> 'audit') > 0 then
    insert into public.audit_log (at, user_id, action, table_name, record_id, old_data, new_data, details)
    select coalesce(r.at, now()), r.user_id, r.action, r.table_name, r.record_id, r.old_data, r.new_data, r.details
    from jsonb_populate_recordset(null::public.audit_log, p -> 'audit') as r;
  end if;
end
$fn$;

revoke all on function public.apply_batch(jsonb) from public, anon;
grant execute on function public.apply_batch(jsonb) to authenticated;
