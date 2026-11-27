-- Итерация 14 (этап 2, docs/STATEMENT-DOCS.md): ссылка операции на строку документа выписки. Бизнес-правил нет.
-- Безопасна для повторного запуска. Старое приложение колонку не использует.
alter table public.transactions add column if not exists statement_row_id uuid references public.statement_rows(id) on delete set null;
create index if not exists idx_transactions_statement_row on public.transactions (statement_row_id) where statement_row_id is not null;
