-- Учёт остатками: новый вид контрольной точки 'entered' (остаток, введённый на экране «Ввод остатков»).
-- Без логики: только расширение проверки значений. Безопасна для повтора.
alter table public.balance_checkpoints drop constraint if exists balance_checkpoints_kind_check;
alter table public.balance_checkpoints add constraint balance_checkpoints_kind_check check (kind in ('balance','portfolio_value','entered'));
