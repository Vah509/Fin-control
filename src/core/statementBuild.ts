// Встраивание документов выписок в учёт (docs/STATEMENT-DOCS.md, этап 2): по кнопке, по одному счёту документа.
// Операции строк (без дублей) получают ссылку statementRowId; переводы между своими счетами: парная запись сразу, а если вторая сторона
// уже создана ранее с другой стороны, она «присваивается» строке (тот же счёт, сумма, дата в пределах 3 дней). Остатки начала и конца периода
// записываются в balance_periods (точки отсчёта). Правки операций (row_marks) подставляются по ключу строки.
import type { Account, BalancePeriod, StatementDocAccount, StatementDocRow, Transaction } from '../data/types'
import { auditEntry } from './audit'
import type { CoreContext } from './context'
import { fail } from './errors'
import { assertUnlocked } from './locks'
import { pairTarget } from './statements/compare'
import { checkTransactionShape } from './transactions'

const DAY = 86_400_000
const THREE_DAYS = 3 * DAY

export interface BuildResult { created: number; adopted: number; unpaired: number; rows: number }

export async function buildStatementAccountIntoLedger(ctx: CoreContext, statementAccountId: string): Promise<BuildResult> {
  if (!ctx.actor.isOwner) fail('FORBIDDEN', 'встраивать выписки может только владелец')
  const s = ctx.storage
  const sa = (await s.list('statementAccounts')).find((a) => a.id === statementAccountId) ?? fail('NOT_FOUND', 'счёт выписки не найден')
  if (sa.builtInAt) fail('INVALID_FIELD', 'эта часть выписки уже встроена в учёт')
  const accounts = await s.list('accounts')
  const acc = accounts.find((a) => a.id === sa.accountId) ?? fail('NOT_FOUND', 'счёт не найден в базе')
  if (acc.archivedAt) fail('ACCOUNT_ARCHIVED', `счёт «${acc.name}» архивный`)
  const rows = (await s.list('statementRows')).filter((r) => r.statementAccountId === sa.id && !r.duplicateOf).sort((a, b) => a.n - b.n)
  const cps = await s.list('counterparties')
  const marks = new Map((await s.list('rowMarks')).map((m) => [`${m.accountId}|${m.rowKey}`, m]))
  const now = ctx.now().toISOString()
  const all = await s.listTransactions({})
  const adopted = new Set<string>()
  const put: Transaction[] = []
  const touched = new Map<string, { acc: Account; at: string }>()
  let created = 0, adoptedN = 0, unpaired = 0

  const touch = (a: Account, at: string) => { const e = touched.get(a.id); if (!e || at < e.at) touched.set(a.id, { acc: a, at }) }
  const mk = (a: Account, r: StatementDocRow, type: Transaction['type'], amountMinor: number, counterpartyId: string | null, transferId: string | null, linked: boolean, desc: string): Transaction => {
    const m = marks.get(`${r.accountId}|${r.rowKey}`)
    const t: Transaction = {
      id: ctx.newId(), accountId: a.id, counterpartyId, importId: null, source: 'import', bookedAt: r.bookedAt, type, amountMinor, currencyKey: a.currencyKey,
      originalAmountMinor: null, originalCurrencyKey: null, tagId: linked ? (m?.tagId ?? null) : null, planType: linked ? (m?.planType ?? null) : null,
      comment: linked ? (m?.comment ?? null) : null, transferId, dedupeHash: null, deletedAt: null, isOpening: false, raw: { n: r.n, description: desc },
      createdBy: ctx.actor.userId, createdAt: now, updatedAt: now, statementRowId: linked ? r.id : null,
    }
    checkTransactionShape(t, a)
    touch(a, r.bookedAt)
    return t
  }

  for (const r of rows) {
    const cp = r.counterpartyId ? (cps.find((c) => c.id === r.counterpartyId) ?? null) : null
    const pt = pairTarget(accounts, cp, acc)
    if (pt?.ok) {
      const rMs = Date.parse(r.bookedAt)
      const candidate = all
        .filter((t) => t.accountId === acc.id && t.type === 'transfer' && !t.statementRowId && !!t.transferId && t.amountMinor === r.amountMinor
          && !adopted.has(t.id) && Math.abs(Date.parse(t.bookedAt) - rMs) <= THREE_DAYS)
        .sort((a, b) => Math.abs(Date.parse(a.bookedAt) - rMs) - Math.abs(Date.parse(b.bookedAt) - rMs))[0]
      if (candidate) {
        adopted.add(candidate.id)
        const m = marks.get(`${r.accountId}|${r.rowKey}`)
        put.push({ ...candidate, statementRowId: r.id, counterpartyId: candidate.counterpartyId ?? cp!.id, tagId: candidate.tagId ?? m?.tagId ?? null,
          planType: candidate.planType ?? m?.planType ?? null, comment: candidate.comment ?? m?.comment ?? null, updatedAt: now })
        touch(acc, candidate.bookedAt)
        adoptedN++
      } else {
        const transferId = ctx.newId()
        const own = cps.find((c) => c.kind === 'own_account' && c.accountId === acc.id)
        put.push(mk(acc, r, 'transfer', r.amountMinor, cp!.id, transferId, true, r.description))
        put.push(mk(pt.target, r, 'transfer', -r.amountMinor, own?.id ?? null, transferId, false, r.description))
        created += 2
      }
    } else {
      if (pt && !pt.ok) unpaired++
      put.push(mk(acc, r, r.amountMinor > 0 ? 'income' : 'expense', r.amountMinor, cp?.id ?? null, null, true, r.description))
      created++
    }
    if (r.feeMinor !== 0) {
      put.push(mk(acc, r, r.feeMinor < 0 ? 'fee' : 'income', r.feeMinor, null, null, true, `Комиссия за операцию №${r.n}`))
      created++
    }
  }
  for (const { acc: a, at } of touched.values()) await assertUnlocked(ctx, a, at)

  // точки отсчёта: период остатков этого счёта выписки (если остатков нет, как у ручного ввода, период не создаётся)
  const periods: BalancePeriod[] = []
  const existing = (await s.list('balancePeriods')).find((p) => p.accountId === acc.id && p.status === 'active' && p.periodStart === sa.periodStart && p.periodEnd === sa.periodEnd)
  if (sa.periodStart && sa.periodEnd && sa.openingMinor !== null && sa.closingMinor !== null && !existing) {
    periods.push({ id: ctx.newId(), accountId: acc.id, periodStart: sa.periodStart, periodEnd: sa.periodEnd, openingMinor: sa.openingMinor, closingMinor: sa.closingMinor,
      source: 'statement', ref: sa.id, status: 'active', note: 'выписка', createdBy: ctx.actor.userId, createdAt: now })
  }
  const nextSa: StatementDocAccount = { ...sa, builtInAt: now }
  await s.applyBatch({
    put: { transactions: put, statementAccounts: [nextSa], ...(periods.length ? { balancePeriods: periods } : {}) },
    audit: [auditEntry(ctx, 'statement_built_in', { tableName: 'statement_accounts', recordId: sa.id, details: { created, adopted: adoptedN, unpaired, rows: rows.length } })],
  })
  return { created, adopted: adoptedN, unpaired, rows: rows.length }
}

/** Убрать часть выписки из учёта: удаляются её операции и авто-пары (не присвоенные строкам других выписок), период остатков помечается ошибочным. */
export async function removeStatementAccountFromLedger(ctx: CoreContext, statementAccountId: string): Promise<{ removed: number }> {
  if (!ctx.actor.isOwner) fail('FORBIDDEN', 'убирать выписки из учёта может только владелец')
  const s = ctx.storage
  const sa = (await s.list('statementAccounts')).find((a) => a.id === statementAccountId) ?? fail('NOT_FOUND', 'счёт выписки не найден')
  if (!sa.builtInAt) fail('INVALID_FIELD', 'эта часть выписки не встроена в учёт')
  const rowIds = new Set((await s.list('statementRows')).filter((r) => r.statementAccountId === sa.id).map((r) => r.id))
  const all = await s.listTransactions({})
  const own = all.filter((t) => t.statementRowId && rowIds.has(t.statementRowId))
  const transferIds = new Set(own.map((t) => t.transferId).filter((x): x is string => !!x))
  const partners = all.filter((t) => !t.statementRowId && t.transferId && transferIds.has(t.transferId))
  const drop = [...own, ...partners]
  const accounts = await s.list('accounts')
  const byAcc = new Map<string, string>()
  for (const t of drop) { const e = byAcc.get(t.accountId); if (!e || t.bookedAt < e) byAcc.set(t.accountId, t.bookedAt) }
  for (const [id, at] of byAcc) await assertUnlocked(ctx, accounts.find((a) => a.id === id)!, at)
  const periods = (await s.list('balancePeriods')).filter((p) => p.ref === sa.id && p.status === 'active').map((p) => ({ ...p, status: 'invalid' as const }))
  await s.applyBatch({
    deleteTransactionIds: drop.map((t) => t.id),
    put: { statementAccounts: [{ ...sa, builtInAt: null }], ...(periods.length ? { balancePeriods: periods } : {}) },
    audit: [auditEntry(ctx, 'statement_removed_from_ledger', { tableName: 'statement_accounts', recordId: sa.id, details: { removed: drop.length } })],
  })
  return { removed: drop.length }
}
