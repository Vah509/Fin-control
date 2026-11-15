-- Итерация 5: задания на импорт выписок (шаг 4, этап Б-1). Бизнес-правил здесь нет.
-- 1) таблица import_jobs (только хранилище: статус, выбранные счета с остатками, текст пакета),
-- 2) права и RLS (только владелец), 3) apply_batch знает таблицу import_jobs.
-- Применять в SQL Editor: сначала тестовый проект, потом рабочий. Безопасна для повторного запуска.

create table if not exists public.import_jobs (
  id uuid primary key,
  status text not null default 'waiting_file'
    check (status in ('preparing', 'waiting_file', 'review', 'loaded', 'cancelled')),
  accounts jsonb not null default '[]'::jsonb,
  package_text text not null default '',
  contract_version integer not null default 1,
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.import_jobs enable row level security;
drop policy if exists import_jobs_select on public.import_jobs;
drop policy if exists import_jobs_insert on public.import_jobs;
drop policy if exists import_jobs_update on public.import_jobs;
create policy import_jobs_select on public.import_jobs for select to authenticated using (app_private.is_any_owner());
create policy import_jobs_insert on public.import_jobs for insert to authenticated with check (app_private.is_any_owner());
create policy import_jobs_update on public.import_jobs for update to authenticated
  using (app_private.is_any_owner()) with check (app_private.is_any_owner());
revoke all on public.import_jobs from anon;
grant select, insert, update on public.import_jobs to authenticated;

-- ---------- Записать пакет: добавлена таблица import_jobs ----------
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
    'transactions', 'balance_checkpoints', 'period_locks', 'fx_rates', 'fx_source_priority', 'import_jobs'];
  v_pks constant text[] := array[
    'key', 'key', 'key', 'key', 'id', 'id', 'id',
    'account_id,user_id', 'id', 'id', 'id', 'id', 'id',
    'id', 'id', 'id', 'id', 'source', 'id'];
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
