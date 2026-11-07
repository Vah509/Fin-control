-- ============================================================
-- Итерация 1, файл 1 из 4: справочники, проекты, счета, доступ,
-- признаки счетов (шифрование), журнал изменений.
-- Применять по порядку файлов. Требуются секреты Vault:
--   identifier_enc_key, identifier_hmac_key (см. supabase/README.md)
-- ============================================================

create extension if not exists pgcrypto   with schema extensions;
create extension if not exists btree_gist with schema extensions;

-- Служебная схема: не открыта через API Supabase.
create schema if not exists app_private;
grant usage on schema app_private to authenticated;

-- ---------- общие триггерные функции ----------
create or replace function app_private.touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

create or replace function app_private.validate_timezone()
returns trigger language plpgsql as $$
begin
  if new.timezone is not null
     and not exists (select 1 from pg_timezone_names where name = new.timezone) then
    raise exception 'Неизвестный часовой пояс: %', new.timezone;
  end if;
  return new;
end $$;

-- ---------- справочники ----------
create table public.countries (
  key        text primary key check (key ~ '^[a-z0-9_-]+$'),
  name       text not null,
  timezone   text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger a_validate_tz before insert or update on public.countries
  for each row execute function app_private.validate_timezone();
create trigger z_touch before update on public.countries
  for each row execute function app_private.touch_updated_at();

create table public.currencies (
  key        text primary key check (key ~ '^[a-z0-9_-]+$'),
  code       text not null unique check (code ~ '^[A-Z]{3}$'),
  name       text,
  decimals   smallint not null default 2 check (decimals between 0 and 4),
  created_at timestamptz not null default now(),
  check (key = lower(code))
);

create table public.institutions (
  id          uuid primary key default gen_random_uuid(),
  key         text not null unique check (key ~ '^[a-z0-9_-]+$'),
  name        text not null,
  kind        text not null default 'bank'
              check (kind in ('bank','wallet_service','broker','firm','other')),
  country_key text references public.countries(key),
  appearance  jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create trigger z_touch before update on public.institutions
  for each row execute function app_private.touch_updated_at();

create table public.projects (
  id         uuid primary key default gen_random_uuid(),
  key        text not null unique check (key ~ '^[a-z0-9_-]+$'),
  name       text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger z_touch before update on public.projects
  for each row execute function app_private.touch_updated_at();

-- ---------- пользователи ----------
create table public.profiles (
  id           uuid primary key references auth.users(id) on delete cascade,
  display_name text,
  created_at   timestamptz not null default now()
);

create or replace function app_private.handle_new_user()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.profiles (id, display_name)
  values (new.id, coalesce(new.raw_user_meta_data ->> 'name', new.email))
  on conflict (id) do nothing;
  return new;
end $$;

create trigger on_auth_user_created after insert on auth.users
  for each row execute function app_private.handle_new_user();

-- ---------- счета ----------
create table public.accounts (
  id              uuid primary key default gen_random_uuid(),
  key             text not null unique check (key ~ '^[a-z0-9_-]+$'),
  name            text not null,
  type            text not null
                  check (type in ('bank','wallet','broker','cash','person','firm')),
  institution_id  uuid references public.institutions(id) on delete restrict,
  project_id      uuid not null references public.projects(id) on delete restrict,
  holder          text,
  currency_key    text not null references public.currencies(key),
  country_key     text not null references public.countries(key),
  timezone        text,                       -- пусто = пояс страны
  tracking_mode   text not null default 'balance_and_movements'
                  check (tracking_mode in ('balance_only','balance_and_movements')),
  service_percent numeric(7,4)
                  check (service_percent is null or service_percent between -100 and 100),
  appearance      jsonb not null default '{}'::jsonb,
  sort_order      integer not null default 0,
  archived_at     timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index idx_accounts_project on public.accounts(project_id);
create trigger a_validate_tz before insert or update on public.accounts
  for each row execute function app_private.validate_timezone();
create trigger z_touch before update on public.accounts
  for each row execute function app_private.touch_updated_at();

create table public.account_access (
  account_id uuid not null references public.accounts(id) on delete cascade,
  user_id    uuid not null references auth.users(id) on delete cascade,
  role       text not null check (role in ('owner','editor','viewer')),
  created_at timestamptz not null default now(),
  primary key (account_id, user_id)
);
create index idx_account_access_user on public.account_access(user_id);

-- ---------- функции доступа (для RLS) ----------
create or replace function app_private.account_role(p_account_id uuid)
returns text language sql stable security definer set search_path = '' as $$
  select aa.role from public.account_access aa
  where aa.account_id = p_account_id and aa.user_id = (select auth.uid())
$$;

create or replace function app_private.can_read(p_account_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select app_private.account_role(p_account_id) is not null
$$;

create or replace function app_private.can_write(p_account_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select coalesce(app_private.account_role(p_account_id) in ('owner','editor'), false)
$$;

create or replace function app_private.is_account_owner(p_account_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select coalesce(app_private.account_role(p_account_id) = 'owner', false)
$$;

create or replace function app_private.is_any_owner()
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.account_access aa
                 where aa.user_id = (select auth.uid()) and aa.role = 'owner')
$$;

-- Владелец проекта = владелец ВСЕХ его счетов (и в проекте есть счета).
create or replace function app_private.is_project_owner(p_project_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.accounts a where a.project_id = p_project_id)
     and not exists (select 1 from public.accounts a
                     where a.project_id = p_project_id
                       and coalesce(app_private.account_role(a.id), '') <> 'owner')
$$;

-- ---------- журнал изменений ----------
create table public.audit_log (
  id         bigint generated always as identity primary key,
  at         timestamptz not null default now(),
  user_id    uuid,
  action     text not null,
  table_name text,
  record_id  text,
  old_data   jsonb,
  new_data   jsonb,
  details    jsonb
);
create index idx_audit_log_at on public.audit_log(at desc);

-- Универсальный аудит. Номера (value_hash, value_enc) и исходные выписки (raw)
-- в журнал не попадают. По операциям пишутся только корректировки.
create or replace function app_private.audit_row()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_old jsonb; v_new jsonb; v_row jsonb;
begin
  if tg_table_name = 'transactions' then
    if tg_op = 'INSERT' and new.type <> 'adjustment' then return null; end if;
    if tg_op = 'UPDATE' and new.type <> 'adjustment' and old.type <> 'adjustment' then return null; end if;
    if tg_op = 'DELETE' and old.type <> 'adjustment' then return null; end if;
  end if;

  if tg_op in ('UPDATE','DELETE') then
    v_old := to_jsonb(old) - 'raw' - 'value_hash' - 'value_enc';
  end if;
  if tg_op in ('INSERT','UPDATE') then
    v_new := to_jsonb(new) - 'raw' - 'value_hash' - 'value_enc';
  end if;
  v_row := coalesce(v_new, v_old);

  insert into public.audit_log (user_id, action, table_name, record_id, old_data, new_data)
  values ((select auth.uid()), lower(tg_op), tg_table_name,
          coalesce(v_row ->> 'id', concat_ws(':', v_row ->> 'account_id', v_row ->> 'user_id')),
          v_old, v_new);
  return null;
end $$;

create trigger audit_accounts after insert or update or delete on public.accounts
  for each row execute function app_private.audit_row();
create trigger audit_account_access after insert or update or delete on public.account_access
  for each row execute function app_private.audit_row();

-- ---------- признаки опознания счетов ----------
create table public.account_identifiers (
  id         uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.accounts(id) on delete cascade,
  kind       text not null
             check (kind in ('account_number','card_mask','wallet_number','statement_name')),
  value_hash bytea not null,          -- HMAC для поиска
  value_enc  bytea not null,          -- pgcrypto, читается только владельцем
  last4      text,
  valid_from date not null default current_date,
  valid_to   date,
  created_at timestamptz not null default now(),
  constraint identifiers_valid_range check (valid_to is null or valid_to >= valid_from),
  -- один признак не может принадлежать двум счетам одновременно
  constraint identifiers_no_overlap
    exclude using gist (value_hash with =, daterange(valid_from, valid_to, '[]') with &&)
);
create index idx_identifiers_account on public.account_identifiers(account_id);
create trigger audit_account_identifiers after insert or update or delete on public.account_identifiers
  for each row execute function app_private.audit_row();

create or replace function app_private.secret(p_name text)
returns text language plpgsql stable security definer set search_path = '' as $$
declare v text;
begin
  select ds.decrypted_secret into v from vault.decrypted_secrets ds where ds.name = p_name limit 1;
  if v is null then
    raise exception 'Секрет "%" не найден в Vault (см. supabase/README.md)', p_name;
  end if;
  return v;
end $$;

create or replace function app_private.normalize_identifier(p_kind text, p_value text)
returns text language sql immutable as $$
  select case when p_kind = 'statement_name'
              then lower(btrim(regexp_replace(p_value, '\s+', ' ', 'g')))
              else upper(regexp_replace(p_value, '\s', '', 'g')) end
$$;

create or replace function app_private.identifier_hash(p_kind text, p_value text)
returns bytea language sql stable security definer set search_path = '' as $$
  select extensions.hmac(
    convert_to(p_kind || ':' || app_private.normalize_identifier(p_kind, p_value), 'UTF8'),
    convert_to(app_private.secret('identifier_hmac_key'), 'UTF8'),
    'sha256')
$$;

-- Добавить признак. p_replaces: закрыть прежний признак днём раньше p_valid_from.
create or replace function public.add_account_identifier(
  p_account_id uuid, p_kind text, p_value text,
  p_valid_from date default current_date, p_replaces uuid default null)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_id uuid; v_old public.account_identifiers;
begin
  if not app_private.can_write(p_account_id) then
    raise exception 'Нет прав на счёт' using errcode = '42501';
  end if;
  if coalesce(btrim(p_value), '') = '' then
    raise exception 'Пустое значение признака';
  end if;

  if p_replaces is not null then
    select * into v_old from public.account_identifiers
    where id = p_replaces and account_id = p_account_id;
    if not found then raise exception 'Заменяемый признак не найден у этого счёта'; end if;
    if v_old.valid_to is not null then raise exception 'Заменяемый признак уже закрыт'; end if;
    if p_valid_from - 1 < v_old.valid_from then
      raise exception 'Дата начала нового признака раньше начала старого';
    end if;
    update public.account_identifiers set valid_to = p_valid_from - 1 where id = p_replaces;
  end if;

  insert into public.account_identifiers
    (account_id, kind, value_hash, value_enc, last4, valid_from)
  values (
    p_account_id, p_kind,
    app_private.identifier_hash(p_kind, p_value),
    extensions.pgp_sym_encrypt(p_value, app_private.secret('identifier_enc_key')),
    case when p_kind = 'statement_name' then null
         else right(regexp_replace(p_value, '[^0-9A-Za-z]', '', 'g'), 4) end,
    p_valid_from)
  returning id into v_id;
  return v_id;
exception when exclusion_violation then
  raise exception 'Этот признак уже принадлежит счёту на указанные даты' using errcode = '23P01';
end $$;

-- Найти счёт по признаку на дату (только среди доступных пользователю).
create or replace function public.find_account_by_identifier(
  p_kind text, p_value text, p_on date default current_date)
returns uuid language sql stable security definer set search_path = '' as $$
  select ai.account_id from public.account_identifiers ai
  where ai.value_hash = app_private.identifier_hash(p_kind, p_value)
    and ai.valid_from <= p_on and (ai.valid_to is null or ai.valid_to >= p_on)
    and app_private.can_read(ai.account_id)
  limit 1
$$;

-- Показать полный номер: только владелец счёта.
create or replace function public.reveal_account_identifier(p_id uuid)
returns text language plpgsql security definer set search_path = '' as $$
declare v_account uuid; v_enc bytea;
begin
  select account_id, value_enc into v_account, v_enc
  from public.account_identifiers where id = p_id;
  if v_account is null or not app_private.is_account_owner(v_account) then
    raise exception 'Нет прав' using errcode = '42501';
  end if;
  insert into public.audit_log (user_id, action, table_name, record_id)
  values ((select auth.uid()), 'reveal', 'account_identifiers', p_id::text);
  return extensions.pgp_sym_decrypt(v_enc, app_private.secret('identifier_enc_key'));
end $$;

-- ---------- RLS ----------
alter table public.countries           enable row level security;
alter table public.currencies          enable row level security;
alter table public.institutions        enable row level security;
alter table public.projects            enable row level security;
alter table public.profiles            enable row level security;
alter table public.accounts            enable row level security;
alter table public.account_access      enable row level security;
alter table public.audit_log           enable row level security;
alter table public.account_identifiers enable row level security;

create policy dict_select on public.countries    for select to authenticated using (true);
create policy dict_select on public.currencies   for select to authenticated using (true);
create policy dict_select on public.institutions for select to authenticated using (true);
create policy dict_select on public.projects     for select to authenticated using (true);

create policy profiles_select on public.profiles for select to authenticated
  using (id = (select auth.uid()));
create policy profiles_update on public.profiles for update to authenticated
  using (id = (select auth.uid())) with check (id = (select auth.uid()));

create policy accounts_select on public.accounts for select to authenticated
  using ((select app_private.can_read(id)));
create policy accounts_update on public.accounts for update to authenticated
  using ((select app_private.is_account_owner(id)))
  with check ((select app_private.is_account_owner(id)));

create policy access_select on public.account_access for select to authenticated
  using (user_id = (select auth.uid()) or (select app_private.is_account_owner(account_id)));
create policy access_insert on public.account_access for insert to authenticated
  with check ((select app_private.is_account_owner(account_id)));
create policy access_update on public.account_access for update to authenticated
  using ((select app_private.is_account_owner(account_id)))
  with check ((select app_private.is_account_owner(account_id)));
create policy access_delete on public.account_access for delete to authenticated
  using ((select app_private.is_account_owner(account_id)));

create policy audit_select on public.audit_log for select to authenticated
  using ((select app_private.is_any_owner()));

create policy identifiers_select on public.account_identifiers for select to authenticated
  using ((select app_private.can_read(account_id)));

-- ---------- права ----------
revoke all on public.countries, public.currencies, public.institutions, public.projects,
              public.profiles, public.accounts, public.account_access, public.audit_log,
              public.account_identifiers
  from anon, authenticated;

grant select on public.countries, public.currencies, public.institutions, public.projects to authenticated;
grant select, update (display_name) on public.profiles to authenticated;
grant select on public.accounts to authenticated;
grant update (name, holder, timezone, tracking_mode, service_percent, appearance, sort_order, archived_at)
  on public.accounts to authenticated;
grant select, insert, update, delete on public.account_access to authenticated;
grant select on public.audit_log to authenticated;
-- номера: только безопасные колонки (value_hash и value_enc клиенту не видны)
grant select (id, account_id, kind, last4, valid_from, valid_to, created_at)
  on public.account_identifiers to authenticated;

revoke execute on all functions in schema app_private from public;
grant execute on function
  app_private.can_read(uuid), app_private.can_write(uuid), app_private.is_account_owner(uuid),
  app_private.is_any_owner(), app_private.is_project_owner(uuid), app_private.account_role(uuid)
  to authenticated;

do $$
declare r record;
begin
  for r in select p.oid::regprocedure as sig from pg_proc p
           join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public'
             and p.proname in ('add_account_identifier','find_account_by_identifier','reveal_account_identifier')
  loop
    execute format('revoke all on function %s from public, anon', r.sig);
    execute format('grant execute on function %s to authenticated', r.sig);
  end loop;
end $$;
