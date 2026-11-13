-- Итерация 2, часть 2: приведение к принципу «база только хранилище» (бриф v3).
-- ЧЕРНОВИК. Данных в тестовой базе нет, поэтому безопасно. Применять после проверки.
-- Остаются: таблицы, типы, CK, UQ, FK, индексы, EXCLUDE по признакам, RLS, updated_at.
-- Уходят: функции и триггеры с бизнес-правилами, шифрование в базе, журнал на триггерах.

-- 1. Публичные функции (rpc) итерации 1
drop function if exists public.add_account_identifier(uuid, text, text, date, uuid);
drop function if exists public.close_period(uuid, date, boolean);
drop function if exists public.convert_amount(numeric, text, text, date);
drop function if exists public.find_account_by_identifier(text, text, date);
drop function if exists public.get_checkpoint_diffs(uuid[], boolean);
drop function if exists public.get_snapshot(date, uuid[], text);
drop function if exists public.get_snapshot_totals(date, uuid[], text);
drop function if exists public.reopen_period(uuid, integer, text);
drop function if exists public.reveal_account_identifier(uuid);

-- 2. Триггеры с логикой (z_touch остаются)
drop trigger if exists audit_account_access on public.account_access;
drop trigger if exists audit_account_identifiers on public.account_identifiers;
drop trigger if exists a_validate_tz on public.accounts;
drop trigger if exists audit_accounts on public.accounts;
drop trigger if exists b_guard_currency on public.accounts;
drop trigger if exists audit_checkpoints on public.balance_checkpoints;
drop trigger if exists b_period_lock on public.balance_checkpoints;
drop trigger if exists a_validate_tz on public.countries;
drop trigger if exists a_validate on public.transactions;
drop trigger if exists audit_transactions on public.transactions;
drop trigger if exists b_period_lock on public.transactions;

-- 3. Служебные функции с логикой
drop function if exists app_private.validate_transaction();
drop function if exists app_private.enforce_period_lock_tx();
drop function if exists app_private.enforce_period_lock_cp();
drop function if exists app_private.assert_unlocked(uuid, timestamptz);
drop function if exists app_private.locked_through(uuid);
drop function if exists app_private.guard_account_currency();
drop function if exists app_private.validate_timezone();
drop function if exists app_private.audit_row();
drop function if exists app_private.fx_rate(text, text, date);
drop function if exists app_private.fx_rate_leg(text, text, date);
drop function if exists app_private.round_to_currency(numeric, text);
drop function if exists app_private.identifier_hash(text, text);
drop function if exists app_private.normalize_identifier(text, text);
drop function if exists app_private.secret(text);
drop function if exists app_private.account_tz(uuid);
-- Остаются: account_role, can_read, can_write, is_account_owner, is_any_owner,
-- is_project_owner, handle_new_user, touch_updated_at.

-- 4. Раньше эти таблицы писались только через rpc. Теперь пишет клиент, права владельцу.
do $$
declare t text;
begin
  foreach t in array array['countries', 'currencies', 'institutions', 'projects'] loop
    execute format('create policy %I on public.%I for insert to authenticated with check (app_private.is_any_owner())', t || '_insert', t);
    execute format('create policy %I on public.%I for update to authenticated using (app_private.is_any_owner()) with check (app_private.is_any_owner())', t || '_update', t);
  end loop;
end $$;

create policy accounts_insert on public.accounts
  for insert to authenticated with check (app_private.is_any_owner());

create policy identifiers_insert on public.account_identifiers
  for insert to authenticated with check (app_private.is_any_owner());
create policy identifiers_update on public.account_identifiers
  for update to authenticated using (app_private.is_any_owner()) with check (app_private.is_any_owner());

create policy locks_insert on public.period_locks
  for insert to authenticated with check (app_private.is_any_owner());
create policy locks_update on public.period_locks
  for update to authenticated using (app_private.is_any_owner()) with check (app_private.is_any_owner());

-- Настройки приложения (базовая валюта, пояс по умолчанию и др.) пишет клиент
create policy settings_insert on public.app_settings
  for insert to authenticated with check (app_private.is_any_owner());
create policy settings_update on public.app_settings
  for update to authenticated using (app_private.is_any_owner()) with check (app_private.is_any_owner());

-- Журнал теперь пишет код (ядро)
create policy audit_insert on public.audit_log
  for insert to authenticated
  with check (app_private.is_any_owner() and user_id = auth.uid());
