# Модель данных (факт на 13 ноября 2026)

Источник правды по схеме: `supabase/migrations/` (с 13.11.2026 там и итерация 2). На чистой базе вся цепочка применяется без ошибок (проверено на Postgres 16 с заглушками Supabase). Соответствие колонок полям ядра: `src/data/supabase/columns.ts`, типы: `src/data/types.ts`. SQLite позже получит ту же схему (деньги целыми, время ISO UTC).

## Таблицы

| Таблица | Сущность ядра | Миграция | Заметки |
|---|---|---|---|
| `app_settings` | appSettings | 1 | ключ-значение: `base_currency`, `default_timezone`, `fx_pivot_currency` |
| `plan_types` | planTypes | 7а | плановость (`planned`, `unplanned`) |
| `countries`, `currencies` | countries, currencies | 1 | пояс страны, число знаков валюты |
| `institutions` | institutions | 1 | банки, Revolut, брокер, фирмы |
| `projects` | projects | 1, 4в | в интерфейсе «разделы»; `sort_order`, `appearance` из 4в |
| `profiles` | нет | 1 | профиль пользователя Auth (триггер при создании) |
| `accounts` | accounts | 1 | неизменный `id`, `key`, валюта одна, `tracking_mode`, `service_percent`, `appearance`, `sort_order`, `archived_at` |
| `account_access` | нет в дампе | 1 | роль на счёт (owner/editor/viewer); сейчас используется только owner; ключ `(account_id, user_id)` |
| `account_identifiers` | accountIdentifiers | 1 | `value_hash`, `value_enc`, `last4`, сроки; из приложения читаются только безопасные колонки; пока не используются |
| `tag_groups`, `tags` | tagGroups, tags | 7а | два уровня |
| `counterparties`, `counterparty_identifiers` | counterparties, counterpartyIdentifiers | 7а | 45 контрагентов в тестовой базе |
| `transactions` | transactions | 1, 7а | сумма со знаком `numeric(18,2)`; проверки знака, нуля, исходной суммы, начальной корректировки; частичные индексы по действующим записям; внешние ключи на контрагентов, теги и плановость (7а); `import_id`, `transfer_id` пока без ключей |
| `balance_checkpoints` | checkpoints | 1 | не участвуют в расчёте, только сверка |
| `period_locks` | periodLocks | 1, 4в | одно общее закрытие; `project_id` пуст у новых записей |
| `fx_rates`, `fx_source_priority` | fxRates, fxSourcePriorities | 1 | курсы `numeric(18,8)`, приоритет источников |
| `audit_log` | журнал | 1, 4в | только дописывается; пишут триггеры БД и ядро |

Нет совсем: `imports`, `import_rows`, `period_summaries`, внешние ключи `import_id` и `transfer_id` (нужны в шаге 5).

## Функции и триггеры в базе

Миграция `20261107100100_iteration2_storage_only.sql` (7б) убирает бизнес-логику итерации 1 из базы. **После всей цепочки на чистой базе остаются:**
- функции: `public.apply_batch(jsonb)` (запись пакета, security invoker), `public.keep_alive()`; `app_private`: `account_role`, `can_read`, `can_write`, `handle_new_user`, `is_account_owner`, `is_any_owner`, `is_project_owner`, `touch_updated_at`;
- мёртвый остаток миграции 4в (в базе после 7б ничего их не вызывает): `app_private.assert_unlocked`, `app_private.locked_through_all`: удалить новой миграцией (долг D2);
- триггеры: `z_touch` (обновление `updated_at`, 8 штук) и `on_auth_user_created`.
Правила, блокировка закрытого периода и журнал только в ядре (`src/core/`).
**Состояние живой тестовой базы неизвестно:** 7б помечена «ЧЕРНОВИК», применена ли она, владелец не подтвердил (`docs/ROADMAP.md`, пункт 0.1).

## Дамп (файл выгрузки)

`{ format: 'fin-control-dump', version: 1, exportedAt, data: { <сущность>: [...] }, auditLog }`. Загрузка в Supabase это слияние по id; старые файлы без порядка разделов и без общего закрытия дополняются значениями по умолчанию (`parseDump`).
