# Модель данных (факт на 13 ноября 2026)

Источник правды по схеме: `supabase/migrations/` (с 13.11.2026 там и итерация 2). На чистой базе вся цепочка применяется без ошибок (проверено на Postgres 16 с заглушками Supabase). Соответствие колонок полям ядра: `src/data/supabase/columns.ts`, типы: `src/data/types.ts`. SQLite позже получит ту же схему (деньги целыми, время ISO UTC).

## Таблицы

| Таблица | Сущность ядра | Миграция | Заметки |
|---|---|---|---|
| `app_settings` | appSettings | 1 | ключ-значение: `base_currency`, `default_timezone`, `fx_pivot_currency`, `account_layout` (разделители между счетами: `{id раздела: [id счетов и разделителей `div:...`]}`, запись только у разделов с разделителями) |
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
| `balance_checkpoints` | checkpoints | 1, итерация 7 (17.11.2026) | не участвуют в расчёте. `kind`: `balance` (сверяется с расчётом), `portfolio_value`, `entered` (учёт остатками, не сверяется; миграция `20261117100000`) |
| `period_locks` | periodLocks | 1, 4в | одно общее закрытие; `project_id` пуст у новых записей |
| `fx_rates`, `fx_source_priority` | fxRates, fxSourcePriorities | 1 | курсы `numeric(18,8)`, приоритет источников |
| `import_jobs` | importJobs | 5 (15.11.2026) | задания на импорт: `status` (preparing, waiting_file, review, loaded, cancelled), `accounts` jsonb (счета с введённым остатком и моментом), `package_text` (пакет для чата), `contract_version`, `review` jsonb (миграция 6, 16.11.2026: принятые ответы чата, решения, итог загрузки); RLS только владелец; без логики |
| `statement_tasks` | statementTasks | 8 (21.11.2026) | задачи разбора выписок: `title`, `file_name`, `status` (active, done, deleted), `state` jsonb (шаги), `payload` jsonb (разобранная выписка без полных номеров; стирается при удалении); RLS только владелец; без логики |
| `statement_problems` | statementProblems | 9 (21.11.2026) | проблемы сравнения выписки с базой, привязаны к задаче: `task_id` (FK на `statement_tasks`, cascade), `kind` (`db_only`: операция есть в базе, в выписке нет; `account_missing`: счёта выписки нет в базе; `transfer_unpaired`: перевод на свой счёт без возможности создать пару; миграция 10), `status` (open, resolved), `transaction_id`, `details` jsonb (дата, сумма, счёт, контрагент); удаляются вместе с задачей (ключ `delete_problem_task_ids` в `apply_batch`) |
| `audit_log` | журнал | 1, 4в | только дописывается; пишет только ядро (триггеры журнала удалены в 7б) |

Нет совсем (ждут пункт 6 `docs/CURRENT-TASK.md`): `imports`, `import_rows`, `period_summaries`, внешние ключи `import_id` и `transfer_id` (нужны в шаге 5).

## Функции и триггеры в базе

Миграция `20261107100100_iteration2_storage_only.sql` (7б) убирает бизнес-логику итерации 1 из базы. **После всей цепочки на чистой базе остаются:**
- функции: `public.apply_batch(jsonb)` (запись пакета, security invoker; с миграции 5 знает и `import_jobs`, с миграции 8 и `statement_tasks`, с миграции 9 и `statement_problems` и ключ `delete_problem_task_ids`), `public.keep_alive()`; `app_private`: `account_role`, `can_read`, `can_write`, `handle_new_user`, `is_account_owner`, `is_any_owner`, `is_project_owner`, `touch_updated_at`;
- триггеры: `z_touch` (обновление `updated_at`, 8 штук) и `on_auth_user_created`.
Правила, блокировка закрытого периода и журнал только в ядре (`src/core/`).
Живая тестовая база (проверено 13.11.2026) соответствует: в `public` только `apply_batch` и `keep_alive`. Мёртвые функции `app_private.assert_unlocked` и `locked_through_all` удалены миграцией `20261113110000_drop_dead_lock_functions.sql` (применена 13.11.2026).

## Дамп (файл выгрузки)

`{ format: 'fin-control-dump', version: 1, exportedAt, data: { <сущность>: [...] }, auditLog }`. Загрузка в Supabase это слияние по id; старые файлы без порядка разделов и без общего закрытия дополняются значениями по умолчанию (`parseDump`).
