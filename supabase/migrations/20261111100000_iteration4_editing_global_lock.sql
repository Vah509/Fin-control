-- Итерация 4 (шаг 4в): создание и правка счетов и разделов, общее закрытие периодов, права записи.
-- Бизнес-правил здесь нет, они в ядре (TypeScript). Только структура и права.
-- Применять в SQL Editor: сначала тестовый проект, потом рабочий. Безопасна для повторного запуска.

-- ---------- 1. Разделы: порядок и оформление ----------
alter table public.projects add column if not exists sort_order integer not null default 0;
alter table public.projects add column if not exists appearance jsonb not null default '{}';

-- ---------- 2. Права записи владельца (RLS) ----------
-- Раздел или счёт может создать и менять только владелец (владелец хотя бы одного счёта).
drop policy if exists projects_insert on public.projects;
create policy projects_insert on public.projects for insert to authenticated
  with check ((select app_private.is_any_owner()));
drop policy if exists projects_update on public.projects;
create policy projects_update on public.projects for update to authenticated
  using ((select app_private.is_any_owner())) with check ((select app_private.is_any_owner()));
grant select, insert, update on public.projects to authenticated;

drop policy if exists accounts_insert on public.accounts;
create policy accounts_insert on public.accounts for insert to authenticated
  with check ((select app_private.is_any_owner()));

-- Владелец может выдать доступ владельца себе на новый счёт (иначе созданный счёт не виден).
drop policy if exists access_bootstrap on public.account_access;
create policy access_bootstrap on public.account_access for insert to authenticated
  with check (user_id = (select auth.uid()) and role = 'owner' and (select app_private.is_any_owner()));

-- Журнал только дописывается, запись только от своего имени.
drop policy if exists audit_insert on public.audit_log;
create policy audit_insert on public.audit_log for insert to authenticated
  with check (user_id is not distinct from (select auth.uid()));

-- ---------- 3. Закрытие периодов: одно общее на все счета ----------
-- project_id остаётся у старых записей, у новых он пустой. Текущее закрытие = последняя действующая запись.
alter table public.period_locks alter column project_id drop not null;
alter table public.period_locks alter column seq drop identity if exists;

drop policy if exists locks_select on public.period_locks;
create policy locks_select on public.period_locks for select to authenticated
  using (exists (select 1 from public.accounts));
drop policy if exists locks_insert on public.period_locks;
create policy locks_insert on public.period_locks for insert to authenticated
  with check ((select app_private.is_any_owner()));
drop policy if exists locks_update on public.period_locks;
create policy locks_update on public.period_locks for update to authenticated
  using ((select app_private.is_any_owner())) with check ((select app_private.is_any_owner()));

create or replace function app_private.locked_through_all()
returns date language sql stable security definer set search_path = '' as $$
  select pl.locked_through from public.period_locks pl
  where pl.status = 'active' order by pl.seq desc limit 1
$$;

-- Защитный слой над ядром: запись с датой не позже общего закрытия запрещена.
create or replace function app_private.assert_unlocked(p_account_id uuid, p_ts timestamptz)
returns void language plpgsql security definer set search_path = '' as $$
declare v_tz text; v_lock date;
begin
  select coalesce(a.timezone, c.timezone) into v_tz
  from public.accounts a join public.countries c on c.key = a.country_key
  where a.id = p_account_id;
  v_lock := app_private.locked_through_all();
  if v_lock is not null and (p_ts at time zone v_tz)::date <= v_lock then
    raise exception 'PERIOD_LOCKED: период закрыт по %, записи не позже этой даты менять нельзя', v_lock;
  end if;
end $$;

-- Старые функции закрытия по проекту заменены ядром и больше не нужны.
drop function if exists public.close_period(uuid, date, boolean);
drop function if exists public.reopen_period(uuid, integer, text);
drop function if exists app_private.locked_through(uuid);

-- ---------- 4. Записать пакет: составной ключ и порядок ----------
-- Добавлено: таблица account_access (ключ из двух колонок); удаление операций выполняется ДО записи
-- (иначе при закрытии периода с удалением помеченных записей защита закрытого периода их не пропустит).
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
    'transactions', 'balance_checkpoints', 'period_locks', 'fx_rates', 'fx_source_priority'];
  v_pks constant text[] := array[
    'key', 'key', 'key', 'key', 'id', 'id', 'id',
    'account_id,user_id', 'id', 'id', 'id', 'id', 'id',
    'id', 'id', 'id', 'id', 'source'];
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
