-- Итерация 2, часть 1: группы тегов, теги, контрагенты, внешние ключи из операций.
-- Только структура и простые ограничения целостности. Бизнес-правил здесь нет.

-- ---------- Теги ----------
create table public.tag_groups (
  id uuid primary key default gen_random_uuid(),
  key text not null unique check (key ~ '^[a-z0-9_-]+$'),
  name text not null,
  is_service boolean not null default false,   -- служебная группа «Разовые»
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.tags (
  id uuid primary key default gen_random_uuid(),
  key text not null unique check (key ~ '^[a-z0-9_-]+$'),
  group_id uuid not null references public.tag_groups(id) on delete restrict,
  name text not null,
  sort_order integer not null default 0,
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint tags_group_name_uq unique (group_id, name)
);
create index idx_tags_group on public.tags (group_id);

-- ---------- Справочник плановости ----------
create table public.plan_types (
  key text primary key check (key ~ '^[a-z0-9_-]+$'),
  name text not null,
  sort_order integer not null default 0,
  created_at timestamptz not null default now()
);

-- ---------- Контрагенты ----------
create table public.counterparties (
  id uuid primary key default gen_random_uuid(),
  key text not null unique check (key ~ '^[a-z0-9_-]+$'),
  name text not null,
  kind text not null check (kind in ('shop', 'person', 'organization', 'own_account')),
  account_id uuid references public.accounts(id) on delete restrict,  -- только для своего счёта
  default_tag_id uuid references public.tags(id) on delete restrict,
  default_plan_type text references public.plan_types(key) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint counterparties_own_account_ck check ((kind = 'own_account') = (account_id is not null))
);
create index idx_counterparties_account on public.counterparties (account_id) where account_id is not null;
create index idx_counterparties_tag on public.counterparties (default_tag_id) where default_tag_id is not null;

create table public.counterparty_identifiers (
  id uuid primary key default gen_random_uuid(),
  counterparty_id uuid not null references public.counterparties(id) on delete cascade,
  kind text not null check (kind in ('account_number', 'statement_name', 'name_pattern')),
  value text,          -- названия и шаблоны (не секрет)
  value_hash bytea,    -- номера: HMAC, считается в коде
  value_enc bytea,     -- номера: шифртекст, шифрует код
  last4 text,
  valid_from date not null default current_date,
  valid_to date,
  created_at timestamptz not null default now(),
  constraint cp_identifiers_range_ck check (valid_to is null or valid_to >= valid_from),
  constraint cp_identifiers_shape_ck check (
    (kind = 'account_number' and value is null and value_hash is not null and value_enc is not null)
    or (kind <> 'account_number' and value is not null and value_hash is null and value_enc is null)
  )
);
create index idx_cp_identifiers_cp on public.counterparty_identifiers (counterparty_id);
create index idx_cp_identifiers_hash on public.counterparty_identifiers (value_hash) where value_hash is not null;
create index idx_cp_identifiers_value on public.counterparty_identifiers (kind, value) where value is not null;

-- ---------- Внешние ключи из операций ----------
alter table public.transactions
  add constraint transactions_counterparty_id_fkey
  foreign key (counterparty_id) references public.counterparties(id) on delete restrict;

alter table public.transactions
  add constraint transactions_tag_id_fkey
  foreign key (tag_id) references public.tags(id) on delete restrict;

-- Плановость операции: жёсткая проверка на два значения заменяется ссылкой на справочник.
-- Данных в таблице нет, поэтому замена безопасна.
alter table public.transactions drop constraint transactions_plan_type_check;
alter table public.transactions
  add constraint transactions_plan_type_fkey
  foreign key (plan_type) references public.plan_types(key) on delete restrict;

-- ---------- Часовой пояс страны ----------
-- Поле countries.timezone остаётся обязательным. Значение 'default' означает
-- «взять пояс из настройки default_timezone в app_settings» (так у страны «Без страны»).
-- Порядок определения пояса (в ядре): пояс счёта (если задан), затем пояс страны,
-- а если там 'default', то настройка default_timezone.
-- Допустимость значения (имя пояса IANA или 'default') проверяет ядро.

-- ---------- updated_at (как в итерации 1) ----------
create trigger z_touch before update on public.tag_groups
  for each row execute function app_private.touch_updated_at();
create trigger z_touch before update on public.tags
  for each row execute function app_private.touch_updated_at();
create trigger z_touch before update on public.counterparties
  for each row execute function app_private.touch_updated_at();

-- ---------- RLS: читать может вошедший, писать владелец ----------
alter table public.tag_groups enable row level security;
alter table public.tags enable row level security;
alter table public.counterparties enable row level security;
alter table public.counterparty_identifiers enable row level security;
alter table public.plan_types enable row level security;

do $$
declare t text;
begin
  foreach t in array array['plan_types', 'tag_groups', 'tags', 'counterparties', 'counterparty_identifiers'] loop
    execute format('create policy %I on public.%I for select to authenticated using (true)', t || '_select', t);
    execute format('create policy %I on public.%I for insert to authenticated with check (app_private.is_any_owner())', t || '_insert', t);
    execute format('create policy %I on public.%I for update to authenticated using (app_private.is_any_owner()) with check (app_private.is_any_owner())', t || '_update', t);
  end loop;
end $$;

create policy counterparty_identifiers_delete on public.counterparty_identifiers
  for delete to authenticated using (app_private.is_any_owner());
