-- Уборка: функции блокировки периода в базе больше ничего не вызывает
-- (триггеры удалены миграцией 20261107100100, блокировка живёт в ядре, src/core/locks.ts).
-- Идемпотентна: безопасна, если функций нет.
drop function if exists app_private.assert_unlocked(uuid, timestamptz);
drop function if exists app_private.locked_through_all();
