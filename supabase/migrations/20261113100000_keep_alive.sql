-- Будильник базы: функция для Cloudflare Worker (docs/keep-alive-worker.md). Бизнес-логики нет, только возвращает 1.
-- Идемпотентна: безопасна, если функция уже создана вручную.
create or replace function public.keep_alive() returns integer language sql as 'select 1';
grant execute on function public.keep_alive() to anon;
