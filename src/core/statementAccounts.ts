// Шаг «Опознание счёта» (перед контрагентами): счёт выписки опознаётся по последним 4 цифрам номера (признак счёта).
import type { StatementTask } from '../data/types'
import type { CoreContext } from './context'
import { fail } from './errors'
import { addAccountLast4 } from './identifiers'
import { getTask, taskStatement, updateTaskState } from './statementTasks'
import { findDbAccount } from './statements/compare'
import type { ParsedStatement } from './statements/types'

export interface StatementAccountStatus {
  key: string
  title: string
  currency: string
  periodStart: string
  periodEnd: string
  /** счёт в базе, если опознан */
  account: { id: string; name: string } | null
}

/** Какие счета выписки опознаны (есть счёт в базе с признаком «последние 4 цифры» на дату выписки и той же валютой). */
export async function statementAccountsStatus(ctx: CoreContext, st: ParsedStatement): Promise<StatementAccountStatus[]> {
  const accounts = await ctx.storage.list('accounts')
  const ids = await ctx.storage.listAccountIdentifiers()
  return st.accounts.map((a) => {
    const db = findDbAccount(accounts, ids, a)
    return { key: a.key, title: a.title, currency: a.currency, periodStart: a.periodStart, periodEnd: a.periodEnd, account: db ? { id: db.id, name: db.name } : null }
  })
}

export const taskAccountsStatus = async (ctx: CoreContext, taskId: string) => statementAccountsStatus(ctx, taskStatement(await getTask(ctx, taskId)))

/** Ставит признак «последние 4 цифры» выбранному счёту. Валюта счёта должна совпадать с валютой счёта в выписке. */
export async function identifyStatementAccount(ctx: CoreContext, taskId: string, statementKey: string, accountId: string): Promise<StatementAccountStatus[]> {
  if (!ctx.actor.isOwner) fail('FORBIDDEN', 'опознавать счёт может только владелец')
  const t = await getTask(ctx, taskId)
  if (t.status === 'done') fail('INVALID_FIELD', 'задача уже закрыта')
  const st = taskStatement(t)
  const sa = st.accounts.find((a) => a.key === statementKey) ?? fail('NOT_FOUND', 'счёта нет в выписке')
  const status = await statementAccountsStatus(ctx, st)
  if (status.find((x) => x.key === statementKey)?.account) fail('INVALID_FIELD', 'счёт уже опознан')
  const acc = (await ctx.storage.list('accounts')).find((a) => a.id === accountId) ?? fail('NOT_FOUND', 'счёт не найден')
  if (acc.archivedAt) fail('ACCOUNT_ARCHIVED', `счёт «${acc.name}» архивный`)
  if (acc.currencyKey.toUpperCase() !== sa.currency.toUpperCase()) fail('INVALID_FIELD', `валюта счёта ${acc.currencyKey.toUpperCase()}, в выписке ${sa.currency}`)
  await addAccountLast4(ctx, acc.id, sa.key)
  return statementAccountsStatus(ctx, st)
}

/** «Следующий шаг»: все счета выписки опознаны. Иначе отказ. */
export async function confirmAccountsRecognized(ctx: CoreContext, taskId: string): Promise<StatementTask> {
  if (!ctx.actor.isOwner) fail('FORBIDDEN', 'шаг выполняет только владелец')
  const status = await taskAccountsStatus(ctx, taskId)
  const bad = status.filter((x) => !x.account)
  if (bad.length) fail('INVALID_FIELD', `счёт неопознан: …${bad.map((x) => x.key).join(', …')}`)
  return updateTaskState(ctx, taskId, { accountsConfirmed: true })
}
