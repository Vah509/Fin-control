// Проблемы сравнения выписки с базой и завершение задачи (шаг 3). Пока в базу движения не пишутся:
// «Готово» только закрывает задачу (включим запись позже, версия 0.2.18).
import type { Json, StatementProblem, StatementTask } from '../data/types'
import { auditEntry } from './audit'
import type { CoreContext } from './context'
import { fail } from './errors'
import { getTask, taskStatement, type StatementTaskState } from './statementTasks'
import { compareWithDb, type Comparison, type ProblemDetails } from './statements/compare'
import { reconcileAccount } from './statements/reconcile'
import { buildStatementTransactions } from './statements/write'

export type { ProblemDetails }

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
  const cmp = await compareWithDb(ctx, st)
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
