-- ============================================================
-- Итерация 1, файл 3 из 4: округление, курсы, срез на дату.
-- Все функции среза работают с правами вызывающего (RLS действует):
-- пользователь видит только свои счета.
-- ============================================================

-- Единственное место округления: обычное, при пересчёте.
-- (5 и больше вверх по модулю; число знаков берётся из справочника валют)
create or replace function app_private.round_to_currency(p_amount numeric, p_currency_key text)
returns numeric language sql stable set search_path = '' as $$
  select round(p_amount,
               coalesce((select c.decimals from public.currencies c where c.key = p_currency_key), 2)::int)
$$;

-- Один «отрезок» курса: прямая пара, затем обратная.
-- Берётся последний курс не позже даты; при равной дате побеждает источник
-- с меньшим priority (нет в fx_source_priority = 1000).
create or replace function app_private.fx_rate_leg(p_from text, p_to text, p_date date)
returns numeric language plpgsql stable set search_path = '' as $$
declare v numeric;
begin
  select r.rate into v
  from public.fx_rates r left join public.fx_source_priority p on p.source = r.source
  where r.base_currency_key = p_from and r.quote_currency_key = p_to and r.rate_date <= p_date
  order by r.rate_date desc, coalesce(p.priority, 1000), r.id limit 1;
  if v is not null then return v; end if;

  select 1 / r.rate into v
  from public.fx_rates r left join public.fx_source_priority p on p.source = r.source
  where r.base_currency_key = p_to and r.quote_currency_key = p_from and r.rate_date <= p_date
  order by r.rate_date desc, coalesce(p.priority, 1000), r.id limit 1;
  return v;
end $$;

-- Курс p_from -> p_to на дату: напрямую или через опорную валюту. Нет курса = NULL.
create or replace function app_private.fx_rate(p_from text, p_to text, p_date date)
returns numeric language plpgsql stable set search_path = '' as $$
declare v numeric; v_pivot text; a numeric; b numeric;
begin
  if p_from = p_to then return 1; end if;
  v := app_private.fx_rate_leg(p_from, p_to, p_date);
  if v is not null then return v; end if;

  select trim(both '"' from s.value::text) into v_pivot
  from public.app_settings s where s.key = 'fx_pivot_currency';
  if v_pivot is null or v_pivot in (p_from, p_to) then return null; end if;

  a := app_private.fx_rate_leg(p_from, v_pivot, p_date);
  b := app_private.fx_rate_leg(v_pivot, p_to, p_date);
  if a is null or b is null then return null; end if;
  return a * b;
end $$;

-- Пересчёт суммы по курсу на дату; NULL, если курса нет.
create or replace function public.convert_amount(
  p_amount numeric, p_from text, p_to text, p_date date)
returns numeric language sql stable set search_path = '' as $$
  select app_private.round_to_currency(p_amount * app_private.fx_rate(p_from, p_to, p_date), p_to)
$$;

-- ---------- срез на дату ----------
-- Остаток = сумма действующих записей счёта до конца дня p_date в поясе счёта.
-- p_account_ids = NULL: все доступные счета; архивные с нулевым остатком
-- не показываются в датах после архивации (прошлые срезы не меняются).
-- Пересчёт: каждый счёт округляется отдельно, итог = сумма округлённых.
create or replace function public.get_snapshot(
  p_date date, p_account_ids uuid[] default null, p_base_currency text default null)
returns table (
  account_id uuid, account_key text, account_name text, account_type text,
  project_id uuid, institution_id uuid, holder text, country_key text,
  currency_key text, tracking_mode text, archived_at timestamptz, sort_order integer,
  balance numeric, base_currency text, rate numeric, balance_base numeric, has_rate boolean)
language sql stable set search_path = '' as $$
  with acc as (
    select a.id, a.key, a.name, a.type, a.project_id, a.institution_id, a.holder,
           a.country_key, a.currency_key, a.tracking_mode, a.archived_at, a.sort_order,
           coalesce(a.timezone, c.timezone) as tz
    from public.accounts a join public.countries c on c.key = a.country_key
    where p_account_ids is null or a.id = any(p_account_ids)
  ), bal as (
    select acc.id, coalesce(sum(t.amount), 0) as balance
    from acc
    left join public.transactions t
      on t.account_id = acc.id and t.deleted_at is null
     and t.booked_at < (((p_date + 1)::timestamp) at time zone acc.tz)
    group by acc.id
  )
  select acc.id, acc.key, acc.name, acc.type, acc.project_id, acc.institution_id, acc.holder,
         acc.country_key, acc.currency_key, acc.tracking_mode, acc.archived_at, acc.sort_order,
         bal.balance,
         p_base_currency,
         fx.rate,
         case when fx.rate is not null
              then app_private.round_to_currency(bal.balance * fx.rate, p_base_currency) end,
         case when p_base_currency is null then null else fx.rate is not null end
  from acc
  join bal on bal.id = acc.id
  cross join lateral (
    select case when p_base_currency is null then null
                else app_private.fx_rate(acc.currency_key, p_base_currency, p_date) end as rate
  ) fx
  where p_account_ids is not null
     or acc.archived_at is null
     or (acc.archived_at at time zone acc.tz)::date > p_date
     or bal.balance <> 0
  order by acc.sort_order, acc.name
$$;

-- Итоги: по каждой валюте (balance) и в одной валюте (balance_base).
-- Строка is_total = общий итог в базовой валюте; has_rate = false значит
-- по части счетов нет курса и итог неполный («нет курса»).
create or replace function public.get_snapshot_totals(
  p_date date, p_account_ids uuid[] default null, p_base_currency text default null)
returns table (
  currency_key text, balance numeric, accounts_count integer,
  base_currency text, balance_base numeric, has_rate boolean, is_total boolean)
language sql stable set search_path = '' as $$
  with s as (select * from public.get_snapshot(p_date, p_account_ids, p_base_currency))
  select s.currency_key, sum(s.balance), count(*)::int, p_base_currency,
         sum(s.balance_base), bool_and(s.has_rate), false
  from s group by s.currency_key
  union all
  select null, null, count(*)::int, p_base_currency,
         sum(s.balance_base), bool_and(s.has_rate), true
  from s
  order by 7, 1
$$;

-- Расхождения контрольных точек с расчётом (остаток на момент as_of
-- включает операции с booked_at <= as_of).
create or replace function public.get_checkpoint_diffs(
  p_account_ids uuid[] default null, p_only_mismatches boolean default true)
returns table (
  checkpoint_id uuid, account_id uuid, as_of timestamptz,
  checkpoint_balance numeric, computed_balance numeric, diff numeric)
language sql stable set search_path = '' as $$
  select cp.id, cp.account_id, cp.as_of, cp.balance,
         coalesce(sum(t.amount), 0), cp.balance - coalesce(sum(t.amount), 0)
  from public.balance_checkpoints cp
  left join public.transactions t
    on t.account_id = cp.account_id and t.deleted_at is null and t.booked_at <= cp.as_of
  where cp.kind = 'balance' and cp.status = 'active'
    and (p_account_ids is null or cp.account_id = any(p_account_ids))
  group by cp.id
  having (not p_only_mismatches) or cp.balance <> coalesce(sum(t.amount), 0)
  order by cp.as_of
$$;

-- ---------- права ----------
revoke execute on all functions in schema app_private from public;
grant execute on function
  app_private.round_to_currency(numeric, text), app_private.fx_rate_leg(text, text, date),
  app_private.fx_rate(text, text, date)
  to authenticated;

do $$
declare r record;
begin
  for r in select p.oid::regprocedure as sig from pg_proc p
           join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public'
             and p.proname in ('convert_amount','get_snapshot','get_snapshot_totals','get_checkpoint_diffs')
  loop
    execute format('revoke all on function %s from public, anon', r.sig);
    execute format('grant execute on function %s to authenticated', r.sig);
  end loop;
end $$;
