// Задачи разбора выписок: каждая загрузка = отдельная задача с шагами; хранится в базе (statement_tasks).
// В базе лежит разобранная выписка без полных номеров: свой IBAN сведён к последним 4 цифрам, IBAN контрагентов
// убраны (в том числе из текста операций). Сам PDF не хранится. Пока нет ключей шифрования, это защита вместо шифра.
import type { Json, StatementTask } from '../data/types'
import { auditEntry } from './audit'
import type { CoreContext } from './context'
import { fail } from './errors'
import type { ParsedStatement } from './statements/types'

export interface CpTotals { rows: number; created: number; identifiersAdded: number; reassigned: number }
export interface StatementTaskState {
  counterpartiesLoaded?: boolean; counterpartyFileDownloaded?: boolean; operationsDone?: boolean
  /** шаг 2: имя последнего загруженного файла, время и накопленный итог (повторная загрузка не стирает результат) */
  counterpartiesFile?: string; counterpartiesAt?: string; counterpartiesTotals?: CpTotals
}

const IBAN_RE = /\b[A-Z]{2}\d{2}(?:\s?[A-Z0-9]{4}){3,6}(?:\s?[A-Z0-9]{1,4})?\b/g
const maskIbans = (s: string) => s.replace(IBAN_RE, (m) => `IBAN…${m.replace(/\s/g, '').slice(-4)}`)

/** Копия выписки без полных номеров. */
export function maskStatement(st: ParsedStatement): ParsedStatement {
  return {
    ...st,
    accounts: st.accounts.map((a) => ({
      ...a,
      number: `IBAN…${a.key}`,
      rows: a.rows.map((r) => ({
        ...r,
        description: maskIbans(r.description),
        counterparty: { ...r.counterparty, name: maskIbans(r.counterparty.name), iban: null },
      })),
    })),
  }
}

export function taskTitle(st: ParsedStatement, fileName: string): string {
  const a = st.accounts[0]
  if (!a) return fileName
  const more = st.accounts.length > 1 ? ` +${st.accounts.length - 1}` : ''
  return `${a.title} …${a.key}${more} · ${a.periodEnd.slice(0, 7)} · ${fileName}`
}

/** Открытые и закрытые задачи, новые сверху; удалённые не показываются. */
export async function listStatementTasks(ctx: CoreContext): Promise<StatementTask[]> {
  return (await ctx.storage.list('statementTasks'))
    .filter((t) => t.status !== 'deleted')
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt) || b.id.localeCompare(a.id))
}

async function getTask(ctx: CoreContext, id: string): Promise<StatementTask> {
  return (await ctx.storage.list('statementTasks')).find((t) => t.id === id && t.status !== 'deleted') ?? fail('NOT_FOUND', 'задача выписки не найдена')
}

export async function createStatementTask(ctx: CoreContext, st: ParsedStatement, fileName: string): Promise<StatementTask> {
  if (!st.accounts.length) fail('STATEMENT_PARSE', 'в выписке нет счетов')
  const now = ctx.now().toISOString()
  const task: StatementTask = {
    id: ctx.newId(), title: taskTitle(st, fileName), fileName, status: 'active', state: {},
    payload: maskStatement(st) as unknown as Json, createdBy: ctx.actor.userId, createdAt: now, updatedAt: now,
  }
  await ctx.storage.applyBatch({ put: { statementTasks: [task] }, audit: [auditEntry(ctx, 'statement_task_created', { tableName: 'statement_tasks', recordId: task.id })] })
  return task
}

export function taskStatement(task: StatementTask): ParsedStatement {
  return task.payload as unknown as ParsedStatement
}

export async function updateTaskState(ctx: CoreContext, id: string, patch: StatementTaskState): Promise<StatementTask> {
  const t = await getTask(ctx, id)
  const state = { ...(t.state as object), ...patch } as StatementTaskState
  const next: StatementTask = { ...t, state: state as Json, status: state.operationsDone ? 'done' : 'active', updatedAt: ctx.now().toISOString() }
  await ctx.storage.applyBatch({ put: { statementTasks: [next] } })
  return next
}

/** Итог загрузки файла контрагентов: имя файла, время, суммарный результат по всем загрузкам этой задачи. */
export async function recordCounterpartyUpload(ctx: CoreContext, id: string, fileName: string, r: CpTotals): Promise<StatementTask> {
  const t = await getTask(ctx, id)
  const prev = (t.state as StatementTaskState).counterpartiesTotals
  const totals: CpTotals = { rows: r.rows, created: (prev?.created ?? 0) + r.created, identifiersAdded: (prev?.identifiersAdded ?? 0) + r.identifiersAdded, reassigned: (prev?.reassigned ?? 0) + r.reassigned }
  return updateTaskState(ctx, id, { counterpartiesLoaded: true, counterpartiesFile: fileName, counterpartiesAt: ctx.now().toISOString(), counterpartiesTotals: totals })
}

/** Удаление: задача пропадает с экрана, разобранные данные стираются. Уже записанные контрагенты остаются. */
export async function deleteStatementTask(ctx: CoreContext, id: string): Promise<void> {
  const t = await getTask(ctx, id)
  await ctx.storage.applyBatch({
    put: { statementTasks: [{ ...t, status: 'deleted', payload: null, state: {}, updatedAt: ctx.now().toISOString() }] },
    audit: [auditEntry(ctx, 'statement_task_deleted', { tableName: 'statement_tasks', recordId: id })],
  })
}
