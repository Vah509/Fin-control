// Проблемы сравнения выписки с базой, их решение владельцем и завершение задачи (шаг 3).
// Обнаруживаются все виды проблем; решения есть у четырёх (db_only, amount_mismatch, account_missing, transfer_unpaired).
// Остальное (date_mismatch и будущие виды) только блокирует «Готово».
import type { Json, StatementProblem, StatementTask, Transaction } from '../data/types'
import { auditEntry } from './audit'
import type { CoreContext } from './context'
import { fail } from './errors'
import { addAccountLast4 } from './identifiers'
import { assertUnlocked } from './locks'
import { readSettings } from './settings'
import { getTask, recordCounterpartyUpload, taskStatement, type StatementTaskState } from './statementTasks'
import { compareWithDb, type Comparison, type ProblemDetails } from './statements/compare'
import { counterpartyStatus } from './statements/counterparties'
import { reconcileAccount } from './statements/reconcile'
import type { StatementDecisions } from './statements/types'
import { buildStatementTransactions, statementBookedAt } from './statements/write'
import { checkTransactionShape } from './transactions'

export type { ProblemDetails }

export const decisionsOf = (t: StatementTask): StatementDecisions => (t.state as StatementTaskState).decisions ?? {}

/** Сравнение выписки задачи с базой с учётом решений владельца. */
export async function compareTask(ctx: CoreContext, taskId: string): Promise<Comparison> {
  const t = await getTask(ctx, taskId)
  return compareWithDb(ctx, taskStatement(t), decisionsOf(t))
}

export async function listTaskProblems(ctx: CoreContext, taskId: string): Promise<StatementProblem[]> {
  return (await ctx.storage.list('statementProblems'))
    .filter((p) => p.taskId === taskId)
    .sort((a, b) => ((a.details as unknown as ProblemDetails).date ?? '').localeCompare((b.details as unknown as ProblemDetails).date ?? '') || a.id.localeCompare(b.id))
}

/** Сохраняет результат сравнения: проблемы задачи заменяются новыми, состояние задачи обновляется одним пакетом. */
export async function saveComparison(ctx: CoreContext, taskId: string, cmp: Comparison): Promise<StatementTask> {
  const t = await getTask(ctx, taskId)
  const now = ctx.now().toISOString()
  const problems: StatementProblem[] = cmp.problems.map((p) => ({
    id: ctx.newId(), taskId, kind: p.kind, status: 'open', transactionId: p.transactionId, createdAt: now, details: p.details as unknown as Json,
  }))
  const state: StatementTaskState = { ...(t.state as StatementTaskState), operationsFileDownloaded: true, comparedAt: now, problemsCount: problems.length, missingAccounts: cmp.missingAccounts }
  const next: StatementTask = { ...t, state: state as Json, updatedAt: now }
  await ctx.storage.applyBatch({
    deleteProblemTaskIds: [taskId],
    put: { statementTasks: [next], statementProblems: problems },
    audit: [auditEntry(ctx, 'statement_compared', { tableName: 'statement_tasks', recordId: taskId, details: { problems: problems.length } })],
  })
  return next
}

/**
 * «Готово»: записывает в базу новые операции выписки одним пакетом и закрывает задачу. Условия: файл создавался (сравнение было),
 * сверка выписки сошлась, проблем нет (сравнение повторяется заново: база могла измениться). Иначе ничего не пишется.
 */
export async function finishStatementTask(ctx: CoreContext, taskId: string): Promise<{ task: StatementTask; written: number }> {
  if (!ctx.actor.isOwner) fail('FORBIDDEN', 'закрывать задачу может только владелец')
  const t = await getTask(ctx, taskId)
  if (t.status === 'done') fail('INVALID_FIELD', 'задача уже закрыта')
  const s = t.state as StatementTaskState
  if (!s.comparedAt) fail('INVALID_FIELD', 'сначала нажмите «Сравнить с базой и скачать файл»')
  const st = taskStatement(t)
  const bad = st.accounts.filter((a) => !reconcileAccount(a).ok)
  if (bad.length) fail('RECONCILE_FAILED', `сверка выписки не сошлась (счёт …${bad.map((a) => a.key).join(', …')}), запись невозможна`)
  const cmp = await compareWithDb(ctx, st, decisionsOf(t))
  if (cmp.problems.length > 0) {
    await saveComparison(ctx, taskId, cmp)
    fail('INVALID_FIELD', `есть нерешённые проблемы: ${cmp.problems.length}`)
  }
  const txs = await buildStatementTransactions(ctx, st, cmp)
  const now = ctx.now().toISOString()
  const next: StatementTask = { ...t, status: 'done', state: { ...s, operationsDone: true, problemsCount: 0, writtenCount: txs.length, writtenAt: now } as unknown as Json, updatedAt: now }
  await ctx.storage.applyBatch({
    put: { statementTasks: [next], transactions: txs },
    deleteProblemTaskIds: [taskId],
    audit: [auditEntry(ctx, 'statement_written', { tableName: 'statement_tasks', recordId: taskId, details: { written: txs.length, accounts: st.accounts.map((a) => a.key) } })],
  })
  return { task: next, written: txs.length }
}

/** Шаг 2 без файла: все контрагенты выписки уже опознаны, сразу к шагу 3. Иначе отказ. */
export async function confirmCounterpartiesRecognized(ctx: CoreContext, taskId: string): Promise<StatementTask> {
  if (!ctx.actor.isOwner) fail('FORBIDDEN', 'шаг выполняет только владелец')
  const t = await getTask(ctx, taskId)
  const st = taskStatement(t)
  const c = await counterpartyStatus(ctx, st)
  if (c.unrecognized.length > 0) fail('INVALID_FIELD', `не опознано контрагентов: ${c.unrecognized.length}, нужен файл контрагентов`)
  const rows = st.accounts.reduce((n, a) => n + a.rows.length, 0)
  return recordCounterpartyUpload(ctx, taskId, 'без файла: все опознаны', { rows, created: 0, identifiersAdded: 0, reassigned: 0 })
}

export type ProblemAction =
  | { kind: 'keep' } | { kind: 'delete' }                                  // db_only: оставить / удалить (мягко)
  | { kind: 'accept_statement' } | { kind: 'keep_base' } | { kind: 'distinct' } // amount_mismatch: сумма выписки / оставить базу / разные операции
  | { kind: 'add_identifier'; accountId: string }                          // account_missing: добавить признак (4 цифры) существующему счёту
  | { kind: 'plain' }                                                      // transfer_unpaired: писать как обычный расход/приход

/**
 * Решение одной проблемы. Меняет данные или решения задачи одним пакетом, затем сравнение пересчитывается и проблемы задачи заменяются.
 * Не подходящее к виду проблемы действие отклоняется.
 */
export async function resolveProblem(ctx: CoreContext, taskId: string, problemId: string, action: ProblemAction): Promise<StatementTask> {
  if (!ctx.actor.isOwner) fail('FORBIDDEN', 'решать проблемы может только владелец')
  const t = await getTask(ctx, taskId)
  if (t.status === 'done') fail('INVALID_FIELD', 'задача уже закрыта')
  const p = (await ctx.storage.list('statementProblems')).find((x) => x.id === problemId && x.taskId === taskId) ?? fail('NOT_FOUND', 'проблема не найдена (список устарел, обновите экран)')
  const d = p.details as unknown as ProblemDetails
  const bad = () => fail('INVALID_FIELD', `действие «${action.kind}» не подходит к этой проблеме`)
  const dec: StatementDecisions = { ...decisionsOf(t) }
  const now = ctx.now().toISOString()
  const puts: Transaction[] = []
  let audit = auditEntry(ctx, 'statement_problem_resolved', { tableName: 'statement_tasks', recordId: taskId, details: { kind: p.kind, action: action.kind } })

  const txOf = async (): Promise<Transaction> => {
    if (!p.transactionId) return fail('NOT_FOUND', 'у проблемы нет операции в базе')
    return (await ctx.storage.listTransactions({ accountIds: await accountIdsOf(ctx, d) })).find((x) => x.id === p.transactionId) ?? fail('NOT_FOUND', 'операция в базе не найдена')
  }

  if (p.kind === 'db_only') {
    if (action.kind === 'keep') dec.keepDb = [...(dec.keepDb ?? []), p.transactionId!]
    else if (action.kind === 'delete') {
      const tx = await txOf()
      const group = tx.transferId
        ? (await ctx.storage.listTransactions({ bookedFrom: new Date(Date.parse(tx.bookedAt) - 2 * 86_400_000).toISOString(), bookedTo: new Date(Date.parse(tx.bookedAt) + 2 * 86_400_000).toISOString() })).filter((x) => x.transferId === tx.transferId)
        : [tx]
      for (const x of group) {
        const acc = (await ctx.storage.list('accounts')).find((a) => a.id === x.accountId) ?? fail('NOT_FOUND', 'счёт не найден')
        await assertUnlocked(ctx, acc, x.bookedAt)
        puts.push({ ...x, deletedAt: now, updatedAt: now })
      }
      audit = auditEntry(ctx, 'statement_tx_deleted', { tableName: 'transactions', recordId: tx.id, details: { taskId, count: puts.length, amountMinor: tx.amountMinor } })
    } else bad()
  } else if (p.kind === 'amount_mismatch') {
    if (!p.transactionId || d.n === undefined) fail('NOT_FOUND', 'у проблемы нет пары')
    const ref = { a: d.accountKey, n: d.n!, tx: p.transactionId! }
    if (action.kind === 'keep_base') dec.keepBase = [...(dec.keepBase ?? []), ref]
    else if (action.kind === 'distinct') dec.distinct = [...(dec.distinct ?? []), ref]
    else if (action.kind === 'accept_statement') {
      const tx = await txOf()
      const accs = await ctx.storage.list('accounts')
      const acc = accs.find((a) => a.id === tx.accountId) ?? fail('NOT_FOUND', 'счёт не найден')
      const settings = readSettings(await ctx.storage.list('appSettings'))
      const bookedAt = statementBookedAt(acc, d.date!, d.n!, await ctx.storage.list('countries'), settings)
      const next: Transaction = { ...tx, amountMinor: d.amountMinor!, bookedAt, updatedAt: now }
      checkTransactionShape(next, acc)
      await assertUnlocked(ctx, acc, tx.bookedAt)
      await assertUnlocked(ctx, acc, bookedAt)
      puts.push(next)
      audit = auditEntry(ctx, 'statement_tx_amount_fixed', { tableName: 'transactions', recordId: tx.id, details: { taskId, fromMinor: tx.amountMinor, toMinor: next.amountMinor, fromAt: tx.bookedAt, toAt: bookedAt } })
    } else bad()
  } else if (p.kind === 'account_missing') {
    if (action.kind !== 'add_identifier') return bad()
    const acc = (await ctx.storage.list('accounts')).find((a) => a.id === action.accountId) ?? fail('NOT_FOUND', 'счёт не найден')
    if (acc.archivedAt) fail('ACCOUNT_ARCHIVED', `счёт «${acc.name}» архивный`)
    if (d.currency && acc.currencyKey.toUpperCase() !== d.currency.toUpperCase()) fail('INVALID_FIELD', `валюта счёта ${acc.currencyKey.toUpperCase()}, в выписке ${d.currency}`)
    await addAccountLast4(ctx, acc.id, d.accountKey)
  } else if (p.kind === 'transfer_unpaired') {
    if (action.kind !== 'plain' || d.n === undefined) return bad()
    dec.plain = [...(dec.plain ?? []), { a: d.accountKey, n: d.n }]
  } else fail('INVALID_FIELD', 'для этого вида проблемы решения пока нет (только фиксируется)')

  const state: StatementTaskState = { ...(t.state as StatementTaskState), decisions: dec }
  const next: StatementTask = { ...t, state: state as Json, updatedAt: now }
  await ctx.storage.applyBatch({ put: { statementTasks: [next], ...(puts.length ? { transactions: puts } : {}) }, audit: [audit] })
  return saveComparison(ctx, taskId, await compareTask(ctx, taskId))
}

async function accountIdsOf(ctx: CoreContext, d: ProblemDetails): Promise<string[]> {
  const ids = (await ctx.storage.listAccountIdentifiers()).filter((i) => i.kind === 'account_number' && i.last4 === d.accountKey).map((i) => i.accountId)
  return ids.length ? ids : fail('NOT_FOUND', 'счёт проблемы не найден')
}
