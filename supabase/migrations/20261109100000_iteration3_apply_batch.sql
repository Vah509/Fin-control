-- Итерация 3: слой хранения Supabase (шаг 4б). Бизнес-правил здесь нет.
-- 1) функция «записать пакет» (всё или ничего), 2) право удалять операции (нужно closePeriod с purgeDeleted),
-- 3) явные права ролей, 4) журнал: id генерируется базой.
-- Применять в SQL Editor: сначала тестовый проект, потом рабочий. Миграция безопасна для повторного запуска.

-- ---------- 1. Записать пакет ----------
-- Вход: jsonb вида
--   { "put": { "<таблица>": [ {колонка: значение, ...}, ... ], ... },
--     "delete_transaction_ids": [ "<uuid>", ... ],
--     "audit": [ {at, user_id, action, table_name, record_id, old_data, new_data, details}, ... ] }
-- Строки вставляются или обновляются по первичному ключу (upsert). Колонки берутся из ключей первой
-- строки каждой таблицы и сверяются с каталогом, поэтому произвольный SQL внутрь не попадает.
-- security invoker: действуют RLS-политики и права вызывающего пользователя.
create or replace function public.apply_batch(p jsonb)
returns void
language plpgsql
security invoker
set search_path = public, pg_temp
as $fn$
declare
  v_tables constant text[] := array[
    'app_settings', 'plan_types', 'countries', 'currencies', 'institutions', 'projects', 'accounts',
    'account_identifiers', 'tag_groups', 'tags', 'counterparties', 'counterparty_identifiers',
    'transactions', 'balance_checkpoints', 'period_locks', 'fx_rates', 'fx_source_priority'];
  v_pks constant text[] := array[
    'key', 'key', 'key', 'key', 'id', 'id', 'id',
    'id', 'id', 'id', 'id', 'id',
    'id', 'id', 'id', 'id', 'source'];
  i int;
  t text;
  pk text;
  v_rows jsonb;
  v_cols text;
  v_set text;
  v_conflict text;
begin
  if p is null or jsonb_typeof(p) <> 'object' then
    raise exception 'BATCH: ожидается объект jsonb';
  end if;

  for i in 1 .. array_length(v_tables, 1) loop
    t := v_tables[i];
    pk := v_pks[i];
    v_rows := p -> 'put' -> t;
    if v_rows is null or jsonb_typeof(v_rows) <> 'array' or jsonb_array_length(v_rows) = 0 then
      continue;
    end if;

    select string_agg(quote_ident(a.attname), ', ' order by a.attnum),
           string_agg(quote_ident(a.attname) || ' = excluded.' || quote_ident(a.attname), ', ' order by a.attnum)
             filter (where a.attname <> pk)
      into v_cols, v_set
    from pg_attribute a
    where a.attrelid = format('public.%I', t)::regclass
      and a.attnum > 0 and not a.attisdropped
      and (v_rows -> 0) ? a.attname;

    if v_cols is null or not ((v_rows -> 0) ? pk) then
      raise exception 'BATCH: в таблице % нет ключа %', t, pk;
    end if;

    v_conflict := case when v_set is null then 'do nothing' else 'do update set ' || v_set end;
    execute format(
      'insert into public.%1$I (%2$s) select %2$s from jsonb_populate_recordset(null::public.%1$I, $1) on conflict (%3$I) %4$s',
      t, v_cols, pk, v_conflict)
      using v_rows;
  end loop;

  if jsonb_typeof(p -> 'delete_transaction_ids') = 'array' and jsonb_array_length(p -> 'delete_transaction_ids') > 0 then
    delete from public.transactions
    where id in (select (e)::uuid from jsonb_array_elements_text(p -> 'delete_transaction_ids') as e);
  end if;

  if jsonb_typeof(p -> 'audit') = 'array' and jsonb_array_length(p -> 'audit') > 0 then
    insert into public.audit_log (at, user_id, action, table_name, record_id, old_data, new_data, details)
    select coalesce(r.at, now()), r.user_id, r.action, r.table_name, r.record_id, r.old_data, r.new_data, r.details
    from jsonb_populate_recordset(null::public.audit_log, p -> 'audit') as r;
  end if;
end
$fn$;

revoke all on function public.apply_batch(jsonb) from public, anon;
grant execute on function public.apply_batch(jsonb) to authenticated;

-- ---------- 2. Удаление операций ----------
-- Нужно только для closePeriod с purgeDeleted (ядро разрешает это владельцу).
drop policy if exists tx_delete on public.transactions;
create policy tx_delete on public.transactions
  for delete to authenticated using (app_private.is_account_owner(account_id));

-- ---------- 3. Явные права ролей ----------
-- anon ничего; authenticated читает и пишет, доступ ограничивают политики RLS.
revoke all on all tables in schema public from anon;
grant select, insert, update on
  public.account_access, public.account_identifiers, public.accounts, public.app_settings,
  public.balance_checkpoints, public.countries, public.counterparties, public.counterparty_identifiers,
  public.currencies, public.fx_rates, public.fx_source_priority, public.institutions, public.period_locks,
  public.plan_types, public.profiles, public.projects, public.tag_groups, public.tags, public.transactions
  to authenticated;
grant delete on public.transactions, public.counterparty_identifiers to authenticated;
-- Журнал только дописывается: читать и вставлять, не менять и не удалять.
grant select, insert on public.audit_log to authenticated;
revoke update, delete on public.audit_log from authenticated;
grant usage, select on all sequences in schema public to authenticated;

-- ---------- 4. Журнал: id выдаёт база ----------
do $do$
declare
  v_ident "char";
  v_def boolean;
begin
  select a.attidentity,
         exists (select 1 from pg_attrdef d where d.adrelid = a.attrelid and d.adnum = a.attnum)
    into v_ident, v_def
  from pg_attribute a
  where a.attrelid = 'public.audit_log'::regclass and a.attname = 'id';

  if v_ident = '' and not v_def then
    alter table public.audit_log alter column id add generated by default as identity;
    perform setval(pg_get_serial_sequence('public.audit_log', 'id'), coalesce((select max(id) from public.audit_log), 0) + 1, false);
  end if;
end
$do$;
