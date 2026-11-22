-- Итерация 10: новые виды проблем выписки (account_missing, transfer_unpaired). Только ослабление проверки kind, данные не затрагиваются.
-- Применять в SQL Editor: сначала тестовый проект. Безопасна для повторного запуска.
alter table public.statement_problems drop constraint if exists statement_problems_kind_check;
alter table public.statement_problems add constraint statement_problems_kind_check
  check (kind in ('db_only', 'account_missing', 'transfer_unpaired'));
