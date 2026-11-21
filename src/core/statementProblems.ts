// Проблемы сравнения выписки с базой и завершение задачи (шаг 3). Пока в базу движения не пишутся:
// «Готово» только закрывает задачу (включим запись позже, версия 0.2.18).
import type { Json, StatementProblem, StatementTask } from '../data/types'
import { auditEntry } from './audit'
import type { CoreContext } from './context'
import { fail } from './errors'
import { getTask, type StatementTaskState } from './statementTasks'
import type { Comparison } from './statements/compare'

export interface ProblemDetails {
  accountKey: string; accountName: string; date: string; amountMinor: number; currency: string
  type: string; counterparty: string | null; comment: string | null
}

export async function listTaskProblems(ctx: CoreContext, taskId: string): Promise<StatementProblem[]> {
  return (await ctx.storage.list('statementProblems'))
    .filter((p) => p.taskId === taskId)
    .sort((a, b) => ((a.details as unknown as ProblemDetails).date).localeCompare((b.details as unknown as ProblemDetails).date) || a.id.localeCompare(b.id))
}

/** Сохраняет результат сравнения: проблемы задачи заменяются новыми, состояние задачи обновляется одним пакетом. */
export async function saveComparison(ctx: CoreContext, taskId: string, cmp: Comparison): Promise<StatementTask> {
  const t = await getTask(ctx, taskId)
  const now = ctx.now().toISOString()
  const problems: StatementProblem[] = cmp.dbOnly.map((d) => ({
    id: ctx.newId(), taskId, kind: 'db_only', status: 'open', transactionId: d.transactionId, createdAt: now,
    details: { accountKey: d.accountKey, accountName: d.accountName, date: d.date, amountMinor: d.amountMinor, currency: d.currency, type: d.type, counterparty: d.counterparty, comment: d.comment } as unknown as Json,
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

/** «Готово»: возможно, когда файл создан и проблем нет. Пока только закрывает задачу, в базу ничего не пишет. */
export async function finishStatementTask(ctx: CoreContext, taskId: string): Promise<StatementTask> {
  if (!ctx.actor.isOwner) fail('FORBIDDEN', 'закрывать задачу может только владелец')
  const t = await getTask(ctx, taskId)
  const s = t.state as StatementTaskState
  if (!s.comparedAt) fail('INVALID_FIELD', 'сначала скачайте файл «Операции + Сверка»')
  if ((s.problemsCount ?? 0) > 0) fail('INVALID_FIELD', 'есть нерешённые проблемы')
  const next: StatementTask = { ...t, status: 'done', state: { ...s, operationsDone: true } as unknown as Json, updatedAt: ctx.now().toISOString() }
  await ctx.storage.applyBatch({ put: { statementTasks: [next] }, audit: [auditEntry(ctx, 'statement_task_finished', { tableName: 'statement_tasks', recordId: taskId })] })
  return next
}
