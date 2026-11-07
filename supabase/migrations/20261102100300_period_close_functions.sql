-- ============================================================
-- Итерация 1, файл 4 из 4: закрытие и открытие периодов.
-- Закрывать и открывать может только владелец проекта
-- (владелец всех его счетов). Прямых изменений period_locks у клиента нет.
-- ============================================================

-- Закрыть период проекта по дату p_through (включительно).
-- Выполняется в порядке: проверки -> (по желанию) удаление помеченных записей
-- -> очистка raw у операций периода -> запись о закрытии.
create or replace function public.close_period(
  p_project_id uuid, p_through date, p_purge_deleted boolean default false)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_prev date; v_id uuid; v_purged integer := 0; v_raw integer := 0;
begin
  if (select auth.uid()) is null then
    raise exception 'Требуется вход' using errcode = '42501';
  end if;
  if not app_private.is_project_owner(p_project_id) then
    raise exception 'Закрывать период может только владелец проекта' using errcode = '42501';
  end if;

  v_prev := app_private.locked_through(p_project_id);
  if v_prev is not null and p_through <= v_prev then
    raise exception 'Период уже закрыт по % (новая дата должна быть позже)', v_prev;
  end if;
  if p_through > current_date then
    raise exception 'Нельзя закрыть период в будущем';
  end if;

  if p_purge_deleted then
    with del as (
      delete from public.transactions t
      using public.accounts a
      where a.id = t.account_id and a.project_id = p_project_id
        and t.deleted_at is not null
        and (t.booked_at at time zone app_private.account_tz(a.id))::date <= p_through
        and (v_prev is null or (t.booked_at at time zone app_private.account_tz(a.id))::date > v_prev)
      returning 1)
    select count(*) into v_purged from del;
  end if;

  -- Исходный JSON выписок больше не нужен (там персональные данные),
  -- dedupe_hash остаётся: защита от повторной загрузки сохраняется.
  with upd as (
    update public.transactions t set raw = null
    from public.accounts a
    where a.id = t.account_id and a.project_id = p_project_id
      and t.raw is not null
      and (t.booked_at at time zone app_private.account_tz(a.id))::date <= p_through
      and (v_prev is null or (t.booked_at at time zone app_private.account_tz(a.id))::date > v_prev)
    returning 1)
  select count(*) into v_raw from upd;

  insert into public.period_locks (project_id, locked_through, locked_by)
  values (p_project_id, p_through, (select auth.uid()))
  returning id into v_id;

  insert into public.audit_log (user_id, action, table_name, record_id, details)
  values ((select auth.uid()), 'close_period', 'period_locks', v_id::text,
          jsonb_build_object('project_id', p_project_id, 'locked_through', p_through,
                             'previous', v_prev, 'purged_deleted', v_purged, 'raw_cleared', v_raw));

  return jsonb_build_object('lock_id', v_id, 'locked_through', p_through,
                            'previous', v_prev, 'purged_deleted', v_purged, 'raw_cleared', v_raw);
end $$;

-- Открыть период: снять p_steps последних закрытий (по умолчанию один шаг назад).
-- Подтверждения («многократные» при глубоком открытии) делает приложение.
create or replace function public.reopen_period(
  p_project_id uuid, p_steps integer default 1, p_reason text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_released integer; v_now date;
begin
  if (select auth.uid()) is null then
    raise exception 'Требуется вход' using errcode = '42501';
  end if;
  if not app_private.is_project_owner(p_project_id) then
    raise exception 'Открывать период может только владелец проекта' using errcode = '42501';
  end if;
  if p_steps is null or p_steps < 1 then
    raise exception 'Число шагов должно быть не меньше 1';
  end if;

  with target as (
    select pl.id from public.period_locks pl
    where pl.project_id = p_project_id and pl.status = 'active'
    order by pl.seq desc limit p_steps),
  upd as (
    update public.period_locks pl
       set status = 'released', released_at = now(),
           released_by = (select auth.uid()), release_reason = p_reason
    from target where pl.id = target.id
    returning 1)
  select count(*) into v_released from upd;

  if v_released = 0 then
    raise exception 'Нет закрытых периодов, которые можно открыть';
  end if;

  v_now := app_private.locked_through(p_project_id);
  insert into public.audit_log (user_id, action, table_name, record_id, details)
  values ((select auth.uid()), 'reopen_period', 'period_locks', p_project_id::text,
          jsonb_build_object('steps', p_steps, 'released', v_released,
                             'locked_through_now', v_now, 'reason', p_reason));

  return jsonb_build_object('released', v_released, 'locked_through', v_now);
end $$;

do $$
declare r record;
begin
  for r in select p.oid::regprocedure as sig from pg_proc p
           join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname in ('close_period','reopen_period')
  loop
    execute format('revoke all on function %s from public, anon', r.sig);
    execute format('grant execute on function %s to authenticated', r.sig);
  end loop;
end $$;

revoke execute on all functions in schema app_private from public;
