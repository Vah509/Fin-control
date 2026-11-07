-- ============================================================
-- Итерация 1, файл 2 из 4: операции, контрольные точки остатков,
-- закрытие периодов, курсы, настройки.
-- counterparty_id, tag_id, import_id, transfer_id пока без внешних
-- ключей: связанные таблицы (контрагенты, теги, импорты) появятся позже.
-- ============================================================

-- ---------- закрытие периодов (таблица) ----------
create table public.period_locks (
  id             uuid primary key default gen_random_uuid(),
  seq            bigint generated always as identity,
  project_id     uuid not null references public.projects(id) on delete restrict,
  locked_through date not null,
  locked_at      timestamptz not null default now(),
  locked_by      uuid,
  status         text not null default 'active' check (status in ('active','released')),
  released_at    timestamptz,
  released_by    uuid,
  release_reason text
);
create index idx_period_locks_project on public.period_locks(project_id, seq desc);

-- Текущая точка закрытия = последняя действующая запись проекта.
create or replace function app_private.locked_through(p_project_id uuid)
returns date language sql stable security definer set search_path = '' as $$
  select pl.locked_through from public.period_locks pl
  where pl.project_id = p_project_id and pl.status = 'active'
  order by pl.seq desc limit 1
$$;

create or replace function app_private.account_tz(p_account_id uuid)
returns text language sql stable set search_path = '' as $$
  select coalesce(a.timezone, c.timezone)
  from public.accounts a join public.countries c on c.key = a.country_key
  where a.id = p_account_id
$$;

-- Проверка: запись с этой датой (в поясе счёта) не в закрытом периоде.
create or replace function app_private.assert_unlocked(p_account_id uuid, p_ts timestamptz)
returns void language plpgsql security definer set search_path = '' as $$
declare v_project uuid; v_tz text; v_lock date;
begin
  select a.project_id, coalesce(a.timezone, c.timezone) into v_project, v_tz
  from public.accounts a join public.countries c on c.key = a.country_key
  where a.id = p_account_id;
  v_lock := app_private.locked_through(v_project);
  if v_lock is not null and (p_ts at time zone v_tz)::date <= v_lock then
    raise exception 'PERIOD_LOCKED: период закрыт по %, записи не позже этой даты менять нельзя', v_lock;
  end if;
end $$;

-- ---------- операции ----------
create table public.transactions (
  id                    uuid primary key default gen_random_uuid(),   -- создаётся на клиенте
  account_id            uuid not null references public.accounts(id) on delete restrict,
  counterparty_id       uuid,
  import_id             uuid,
  source                text not null default 'manual' check (source in ('import','manual')),
  booked_at             timestamptz not null,
  type                  text not null
                        check (type in ('income','expense','transfer','fee','adjustment')),
  amount                numeric(18,2) not null,        -- со знаком, в валюте счёта
  currency_key          text not null references public.currencies(key),
  original_amount       numeric(18,2),
  original_currency_key text references public.currencies(key),
  tag_id                uuid,
  plan_type             text check (plan_type in ('planned','unplanned')),
  comment               text,
  transfer_id           uuid,
  dedupe_hash           text,
  deleted_at            timestamptz,                   -- мягкое удаление
  is_opening            boolean not null default false,
  raw                   jsonb,
  created_by            uuid,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  constraint tx_amount_nonzero check (amount <> 0),
  constraint tx_sign check (
    (type = 'income' and amount > 0)
    or (type in ('expense','fee') and amount < 0)
    or type in ('transfer','adjustment')),
  constraint tx_original check (
    (original_amount is null) = (original_currency_key is null)
    and (original_amount is null or (original_amount <> 0 and sign(original_amount) = sign(amount)))),
  constraint tx_opening_is_adjustment check (not is_opening or type = 'adjustment')
);

-- Срезы и отчёты всегда фильтруют deleted_at IS NULL.
create index idx_transactions_active on public.transactions (account_id, booked_at)
  where deleted_at is null;
-- Одна начальная корректировка на счёт.
create unique index uq_transactions_opening on public.transactions (account_id)
  where is_opening and deleted_at is null;

create or replace function app_private.validate_transaction()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_cur text; v_archived timestamptz;
begin
  select a.currency_key, a.archived_at into v_cur, v_archived
  from public.accounts a where a.id = new.account_id;

  if new.currency_key is null then
    new.currency_key := v_cur;
  elsif new.currency_key <> v_cur then
    raise exception 'Валюта операции (%) не совпадает с валютой счёта (%)', new.currency_key, v_cur;
  end if;

  if tg_op = 'INSERT' then
    if v_archived is not null then
      raise exception 'Счёт в архиве, новые операции добавлять нельзя';
    end if;
    new.created_by := coalesce((select auth.uid()), new.created_by);
  end if;
  return new;
end $$;

create or replace function app_private.enforce_period_lock_tx()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_op in ('UPDATE','DELETE') then
    perform app_private.assert_unlocked(old.account_id, old.booked_at);
  end if;
  if tg_op in ('INSERT','UPDATE') then
    perform app_private.assert_unlocked(new.account_id, new.booked_at);
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end $$;

create trigger a_validate before insert or update on public.transactions
  for each row execute function app_private.validate_transaction();
create trigger b_period_lock before insert or update or delete on public.transactions
  for each row execute function app_private.enforce_period_lock_tx();
create trigger z_touch before update on public.transactions
  for each row execute function app_private.touch_updated_at();
create trigger audit_transactions after insert or update or delete on public.transactions
  for each row execute function app_private.audit_row();

-- Валюту счёта нельзя менять, если по нему уже есть операции.
create or replace function app_private.guard_account_currency()
returns trigger language plpgsql as $$
begin
  if new.currency_key <> old.currency_key
     and exists (select 1 from public.transactions t where t.account_id = old.id) then
    raise exception 'Нельзя менять валюту счёта, по которому есть операции';
  end if;
  return new;
end $$;
create trigger b_guard_currency before update on public.accounts
  for each row execute function app_private.guard_account_currency();

-- ---------- контрольные точки остатков ----------
-- Не участвуют в расчёте: зафиксированный факт «в этот момент остаток был X».
create table public.balance_checkpoints (
  id         uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.accounts(id) on delete restrict,
  as_of      timestamptz not null,
  balance    numeric(18,2) not null,           -- может быть отрицательным
  kind       text not null default 'balance' check (kind in ('balance','portfolio_value')),
  source     text not null default 'manual' check (source in ('manual','statement')),
  status     text not null default 'active' check (status in ('active','invalid')),
  note       text,
  created_by uuid,
  created_at timestamptz not null default now()
);
create index idx_checkpoints_account on public.balance_checkpoints (account_id, as_of);

create or replace function app_private.enforce_period_lock_cp()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_op in ('UPDATE','DELETE') then
    perform app_private.assert_unlocked(old.account_id, old.as_of);
  end if;
  if tg_op in ('INSERT','UPDATE') then
    perform app_private.assert_unlocked(new.account_id, new.as_of);
  end if;
  if tg_op = 'INSERT' then new.created_by := coalesce((select auth.uid()), new.created_by); end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end $$;
create trigger b_period_lock before insert or update or delete on public.balance_checkpoints
  for each row execute function app_private.enforce_period_lock_cp();
create trigger audit_checkpoints after insert or update or delete on public.balance_checkpoints
  for each row execute function app_private.audit_row();

-- ---------- курсы и настройки ----------
create table public.fx_rates (
  id                 uuid primary key default gen_random_uuid(),
  rate_date          date not null,
  base_currency_key  text not null references public.currencies(key),
  quote_currency_key text not null references public.currencies(key),
  rate               numeric(18,8) not null check (rate > 0),   -- 1 base = rate quote
  source             text not null default 'manual',
  created_at         timestamptz not null default now(),
  check (base_currency_key <> quote_currency_key),
  unique (base_currency_key, quote_currency_key, rate_date, source)
);

-- Приоритет источников при нескольких курсах на одну дату (меньше = важнее).
create table public.fx_source_priority (
  source   text primary key,
  priority integer not null
);

create table public.app_settings (
  key   text primary key,
  value jsonb not null
);
-- Опорная валюта для расчёта пар, которых нет напрямую (меняется настройкой).
insert into public.app_settings (key, value) values ('fx_pivot_currency', '"uah"');

-- ---------- RLS ----------
alter table public.period_locks        enable row level security;
alter table public.transactions        enable row level security;
alter table public.balance_checkpoints enable row level security;
alter table public.fx_rates            enable row level security;
alter table public.fx_source_priority  enable row level security;
alter table public.app_settings        enable row level security;

create policy locks_select on public.period_locks for select to authenticated
  using (exists (select 1 from public.accounts a where a.project_id = period_locks.project_id));

create policy tx_select on public.transactions for select to authenticated
  using ((select app_private.can_read(account_id)));
create policy tx_insert on public.transactions for insert to authenticated
  with check ((select app_private.can_write(account_id)));
create policy tx_update on public.transactions for update to authenticated
  using ((select app_private.can_write(account_id)))
  with check ((select app_private.can_write(account_id)));

create policy cp_select on public.balance_checkpoints for select to authenticated
  using ((select app_private.can_read(account_id)));
create policy cp_insert on public.balance_checkpoints for insert to authenticated
  with check ((select app_private.can_write(account_id)));
create policy cp_update on public.balance_checkpoints for update to authenticated
  using ((select app_private.can_write(account_id)))
  with check ((select app_private.can_write(account_id)));

create policy fx_select on public.fx_rates for select to authenticated using (true);
create policy fx_insert on public.fx_rates for insert to authenticated
  with check ((select app_private.is_any_owner()));
create policy fx_update on public.fx_rates for update to authenticated
  using ((select app_private.is_any_owner())) with check ((select app_private.is_any_owner()));
create policy fx_delete on public.fx_rates for delete to authenticated
  using ((select app_private.is_any_owner()));

create policy prio_select on public.fx_source_priority for select to authenticated using (true);
create policy settings_select on public.app_settings for select to authenticated using (true);

-- ---------- права ----------
revoke all on public.period_locks, public.transactions, public.balance_checkpoints,
              public.fx_rates, public.fx_source_priority, public.app_settings
  from anon, authenticated;

grant select on public.period_locks, public.fx_source_priority, public.app_settings to authenticated;
-- Жёсткого удаления операций у клиента нет: только мягкое (deleted_at) и при закрытии периода.
grant select, insert, update on public.transactions to authenticated;
grant select, insert, update on public.balance_checkpoints to authenticated;
grant select, insert, update, delete on public.fx_rates to authenticated;

revoke execute on all functions in schema app_private from public;
grant execute on function app_private.locked_through(uuid), app_private.account_tz(uuid)
  to authenticated;
