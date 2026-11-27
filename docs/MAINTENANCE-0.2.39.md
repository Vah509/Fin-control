# Разовые скрипты данных к версии 0.2.39 (этап 2)

Выполнять в SQL Editor (или через MCP) **только после того, как приложение версии 0.2.39 развёрнуто**: старый код после скрипта А считает остатки неверно.

## А. Начальные остатки в точки отсчёта (нужен любой базе, где есть `is_opening`)
Каждая операция `is_opening` становится ручным периодом в `balance_periods` (точка на конец предыдущего дня в поясе счёта), сама операция помечается удалённой. Повторный запуск безопасен.

insert into public.balance_periods (id, account_id, period_start, period_end, opening_balance, closing_balance, source, ref, status, note) select gen_random_uuid(), t.account_id, ((t.booked_at - interval '1 millisecond') at time zone coalesce(a.timezone, c.timezone, 'Europe/Bratislava'))::date, ((t.booked_at - interval '1 millisecond') at time zone coalesce(a.timezone, c.timezone, 'Europe/Bratislava'))::date, t.amount, t.amount, 'manual', 'opening:' || t.id::text, 'active', 'Начальный остаток (перенос из операций)' from public.transactions t join public.accounts a on a.id = t.account_id left join public.countries c on c.key = a.country_key where t.is_opening and t.deleted_at is null and not exists (select 1 from public.balance_periods p where p.ref = 'opening:' || t.id::text);

update public.transactions set deleted_at = now() where is_opening and deleted_at is null and exists (select 1 from public.balance_periods p where p.ref = 'opening:' || transactions.id::text);

## Б. Удалить операции, записанные из выписок (решение владельца 27.11.2026, только тестовая база)
Выписки теперь сохраняются документами и встраиваются в учёт кнопкой, поэтому старые операции `source = 'import'` (в том числе авто-пары переводов) удаляются и затем встраиваются заново из документов. Перед запуском посчитать: `select count(*) from public.transactions where source = 'import' and deleted_at is null` (не приложение, а владелец сверяет число).

delete from public.transactions where source = 'import';

## Проверка после
Срез на любую дату; остатки счетов должны быть теми же, что в выписках, для счетов, чьи выписки встроены (кнопка «Встроить в учёт» на экране «Выписки»).
