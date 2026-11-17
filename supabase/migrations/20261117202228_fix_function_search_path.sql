-- Задан search_path у функций (предупреждение безопасности function_search_path_mutable). Бизнес-логики нет.
-- Применена через MCP 17.11.2026 в тестовой базе.
alter function public.keep_alive() set search_path = '';
alter function app_private.touch_updated_at() set search_path = '';
