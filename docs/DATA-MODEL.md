# Модель данных (факт на 13 ноября 2026)

Источник правды по схеме: `supabase/migrations/` плюс таблицы итерации 2, **которых в git нет** (помечены «вручную»). Соответствие колонок полям ядра: `src/data/supabase/columns.ts`, типы: `src/data/types.ts`. SQLite позже получит ту же схему (деньги целыми, время ISO UTC).

## Таблицы

| Таблица | Сущность ядра | Миграция | Заметки |
|---|---|---|---|
| `app_settings` | appSettings | 1 | ключ-значение: `base_currency`, `default_timezone`, `fx_pivot_currency` |
| `plan_types` | planTypes | вручную | плановость (`planned`, `unplanned`) |
| `countries`, `currencies` | countries, currencies | 1 | пояс страны, число знаков валюты |
| `institutions` | institutions | 1 | банки, Revolut, брокер, фирмы |
| `projects` | projects | 1, 4в | в интерфейсе «разделы»; `sort_order`, `appearance` из 4в |
| `profiles` | нет | 1 | профиль пользователя Auth (триггер при создании) |
| `accounts` | accounts | 1 | неизменный `id`, `key`, валюта одна, `tracking_mode`, `service_percent`, `appearance`, `sort_order`, `archived_at` |
| `account_access` | нет в дампе | 1 | роль на счёт (owner/editor/viewer); сейчас используется только owner; ключ `(account_id, user_id)` |
| `account_identifiers` | accountIdentifiers | 1 | `value_hash`, `value_enc`, `last4`, сроки; из приложения читаются только безопасные колонки; пока не используются |
| `tag_groups`, `tags` | tagGroups, tags | вручную | два уровня |
| `counterparties`, `counterparty_identifiers` | counterparties, counterpartyIdentifiers | вручную | 45 контрагентов в тестовой базе |
| `transactions` | transactions | 1 | сумма со знаком `numeric(18,2)`; проверки знака, нуля, исходной суммы, начальной корректировки; частичные индексы по действующим записям; `counterparty_id`, `tag_id`, `import_id`, `transfer_id` без внешних ключей |
| `balance_checkpoints` | checkpoints | 1 | не участвуют в расчёте, только сверка |
| `period_locks` | periodLocks | 1, 4в | одно общее закрытие; `project_id` пуст у новых записей |
| `fx_rates`, `fx_source_priority` | fxRates, fxSourcePriorities | 1 | курсы `numeric(18,8)`, приоритет источников |
| `audit_log` | журнал | 1, 4в | только дописывается; пишут триггеры БД и ядро |

Нет совсем: `imports`, `import_rows`, `period_summaries`, внешние ключи операций на контрагентов, теги, импорты, переводы (нужны в шаге 5).

## Функции и триггеры в базе

Бизнес-логика по принципу «база только хранилище» должна жить в ядре. Фактически в базе остаются:
- **нужные**: `keep_alive()` (миграция 13.11.2026), `apply_batch(jsonb)` (запись пакета, security invoker), политики RLS, `app_private.*` помощники прав, `touch_updated_at`, `handle_new_user`;
- **защитный слой** (оставлены намеренно): триггеры `validate_transaction`, `b_period_lock` (смотрит на общее закрытие после 4в), `guard_account_currency`, `validate_timezone`;
- **остатки итерации 1, приложением не используются** (долг D2): `get_snapshot`, `get_snapshot_totals`, `get_checkpoint_diffs`, `convert_amount`, `add_account_identifier`, `find_account_by_identifier`, `reveal_account_identifier`, `round_to_currency`, `fx_rate*`; триггеры журнала `audit_*` (возможен двойной журнал вместе с записями ядра).
Удалены миграцией 4в: `close_period`, `reopen_period`, `locked_through(uuid)`.

## Дамп (файл выгрузки)

`{ format: 'fin-control-dump', version: 1, exportedAt, data: { <сущность>: [...] }, auditLog }`. Загрузка в Supabase это слияние по id; старые файлы без порядка разделов и без общего закрытия дополняются значениями по умолчанию (`parseDump`).
