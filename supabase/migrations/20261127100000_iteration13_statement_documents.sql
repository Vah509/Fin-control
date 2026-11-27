-- Итерация 13 (этап 1, docs/STATEMENT-DOCS.md): выписки как документы. Бизнес-правил здесь нет, только хранилище.
-- 1) statement_documents (шапка), statement_accounts (счёт в документе, остатки), statement_rows (строки, ссылка duplicate_of),
--    row_marks (правки операции по ключу строки),
-- 2) RLS: только владелец (как statement_tasks); удаление документа каскадом убирает счета и строки, duplicate_of обнуляется,
-- 3) apply_batch знает новые таблицы и delete_statement_document_ids.
-- Применять в SQL Editor: сначала тестовый проект, потом рабочий. Безопасна для повторного запуска.

create table if not exists public.statement_documents (
  id uuid primary key,
  kind text not null default 'statement' check (kind in ('statement', 'manual')),
  institution_id uuid references public.institutions(id) on delete restrict,
  bank text not null default '',
  file_name text not null default '',
  content_hash text,
  period_start date,
  period_end date,
  parser text not null default '',
  created_by uuid,
  created_at timestamptz not null default now()
);
create unique index if not exists uq_statement_documents_hash on public.statement_documents (content_hash) where content_hash is not null;

create table if not exists public.statement_accounts (
  id uuid primary key,
  document_id uuid not null references public.statement_documents(id) on delete cascade,
  account_id uuid not null references public.accounts(id) on delete restrict,
  period_start date,
  period_end date,
  opening_balance numeric(18,2),
  closing_balance numeric(18,2),
  total_income numeric(18,2),
  total_expense numeric(18,2),
  row_count int not null default 0,
  built_in_at timestamptz
);
create index if not exists idx_statement_accounts_doc on public.statement_accounts (document_id);
create index if not exists idx_statement_accounts_account on public.statement_accounts (account_id);

create table if not exists public.statement_rows (
  id uuid primary key,
  document_id uuid not null references public.statement_documents(id) on delete cascade,
  statement_account_id uuid not null references public.statement_accounts(id) on delete cascade,
  account_id uuid not null references public.accounts(id) on delete restrict,
  n int not null,
  booked_at timestamptz not null,
  value_date date,
  amount numeric(18,2) not null,
  fee_amount numeric(18,2) not null default 0,
  balance_after numeric(18,2),
  counterparty_id uuid references public.counterparties(id) on delete set null,
  title text,
  description text not null default '',
  card_mask text,
  row_key text not null,
  duplicate_of uuid references public.statement_rows(id) on delete set null
);
create index if not exists idx_statement_rows_doc on public.statement_rows (document_id);
create index if not exists idx_statement_rows_key on public.statement_rows (account_id, row_key);

create table if not exists public.row_marks (
  id uuid primary key,
  account_id uuid not null references public.accounts(id) on delete restrict,
  row_key text not null,
  tag_id uuid references public.tags(id) on delete set null,
  plan_type text,
  comment text,
  updated_at timestamptz not null default now()
);
create unique index if not exists uq_row_marks_key on public.row_marks (account_id, row_key);

do $$
declare t text;
begin
  foreach t in array array['statement_documents', 'statement_accounts', 'statement_rows', 'row_marks'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists %I on public.%I', t || '_select', t);
    execute format('drop policy if exists %I on public.%I', t || '_insert', t);
    execute format('drop policy if exists %I on public.%I', t || '_update', t);
    execute format('drop policy if exists %I on public.%I', t || '_delete', t);
    execute format('create policy %I on public.%I for select to authenticated using (app_private.is_any_owner())', t || '_select', t);
    execute format('create policy %I on public.%I for insert to authenticated with check (app_private.is_any_owner())', t || '_insert', t);
    execute format('create policy %I on public.%I for update to authenticated using (app_private.is_any_owner()) with check (app_private.is_any_owner())', t || '_update', t);
    execute format('create policy %I on public.%I for delete to authenticated using (app_private.is_any_owner())', t || '_delete', t);
    execute format('revoke all on public.%I from anon', t);
    execute format('grant select, insert, update, delete on public.%I to authenticated', t);
  end loop;
end $$;

-- ---------- Записать пакет: новые таблицы и удаление документов ----------
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
    'transactions', 'balance_checkpoints', 'period_locks', 'fx_rates', 'fx_source_priority', 'import_jobs', 'statement_tasks', 'statement_problems', 'balance_periods',
    'statement_documents', 'statement_accounts', 'statement_rows', 'row_marks'];
  v_pks constant text[] := array[
    'key', 'key', 'key', 'key', 'id', 'id', 'id',
    'account_id,user_id', 'id', 'id', 'id', 'id', 'id',
    'id', 'id', 'id', 'id', 'source', 'id', 'id', 'id', 'id',
    'id', 'id', 'id', 'id'];
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

  if jsonb_typeof(p -> 'delete_statement_document_ids') = 'array' and jsonb_array_length(p -> 'delete_statement_document_ids') > 0 then
    delete from public.statement_documents
    where id in (select (e)::uuid from jsonb_array_elements_text(p -> 'delete_statement_document_ids') as e);
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
