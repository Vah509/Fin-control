// Начальный остаток из выписки (шаг 5): создать или передвинуть на начало периода выписки.
// Нужно, когда выписки грузятся не по порядку: более ранняя выписка ставит начальный остаток раньше уже существующего.
import { accountTimeZone, assertUnlocked } from '../locks'
import { auditEntry } from '../audit'
import type { CoreContext } from '../context'
import { fail } from '../errors'
import { buildTransaction, transactionAudit } from '../transactions'
import { endOfLocalDayMs, startOfLocalDayMs } from '../time'
import { findDbAccount, type Comparison } from './compare'
import type { ParsedStatement } from './types'
import { buildStatementTransactions } from './write'

export interface OpeningFixPlan {
  accountKey: string
  accountId: string
  accountName: string
  kind: 'create' | 'move'
  /** начальный остаток выписки и момент, на который он ставится (за миллисекунду до начала периода) */
  openingMinor: number
  openingAt: string
  /** только для move: прежний начальный остаток и что с ним будет */
  oldOpeningId?: string
  oldOpeningMinor?: number
  /** разница: прежний начальный остаток минус то, что объясняют движения; 0 = прежний остаток удаляется */
  gapMinor?: number
}
export interface OpeningFixResult { plans: OpeningFixPlan[]; blocked: { accountKey: string; reason: string }[] }

/** Для каждого счёта, где начало не сходится из-за отсутствия начального остатка на этот период. Если до начала периода есть записи, предложения нет. */
export async function planOpeningFixes(ctx: CoreContext, st: ParsedStatement, cmp: Comparison): Promise<OpeningFixResult> {
  const s = ctx.storage
  const accounts = await s.list('accounts')
  const ids = await s.listAccountIdentifiers()
  const added = await buildStatementTransactions(ctx, st, cmp)
  const out: OpeningFixResult = { plans: [], blocked: [] }
  for (const acc of st.accounts) {
    const db = findDbAccount(accounts, ids, acc)
    if (!db) continue
    const tz = await accountTimeZone(ctx, db)
    const startMs = startOfLocalDayMs(acc.periodStart, tz)
    const all = (await s.listTransactions({ accountId: db.id })).filter((t) => !t.deletedAt)
    const before = all.filter((t) => Date.parse(t.bookedAt) < startMs)
    if (before.length > 0) continue // настоящая ошибка (пропуск или дубль), не отсутствие стартового остатка
    const startDb = 0
    if (startDb === acc.openingMinor) continue
    const old = all.find((t) => t.isOpening) ?? null
    const openingAt = new Date(startMs - 1).toISOString()
    const base = { accountKey: acc.key, accountId: db.id, accountName: db.name, openingMinor: acc.openingMinor, openingAt }
    if (!old) { out.plans.push({ ...base, kind: 'create' }); continue }
    const oldMs = Date.parse(old.bookedAt)
    const mine = added.filter((t) => t.accountId === db.id)
    if (mine.some((t) => Date.parse(t.bookedAt) >= oldMs)) {
      out.blocked.push({ accountKey: acc.key, reason: 'период выписки пересекается с уже введённым начальным остатком' }); continue
    }
    const between = all.filter((t) => t.id !== old.id && Date.parse(t.bookedAt) < oldMs).reduce((n, t) => n + t.amountMinor, 0)
    const explained = acc.openingMinor + between + mine.reduce((n, t) => n + t.amountMinor, 0)
    out.plans.push({ ...base, kind: 'move', oldOpeningId: old.id, oldOpeningMinor: old.amountMinor, gapMinor: old.amountMinor - explained })
  }
  return out
}

/** Применяет предложения одним пакетом. Только владелец. Закрытые периоды не трогаются (ошибка PERIOD_LOCKED). */
export async function applyOpeningFixes(ctx: CoreContext, st: ParsedStatement, cmp: Comparison, accountKeys: string[]): Promise<number> {
  if (!ctx.actor.isOwner) fail('FORBIDDEN', 'начальный остаток создаёт только владелец')
  const { plans } = await planOpeningFixes(ctx, st, cmp)
  const chosen = plans.filter((p) => accountKeys.includes(p.accountKey))
  if (chosen.length === 0) fail('INVALID_FIELD', 'нечего создавать: остатки уже изменились, обновите проверку')
  const accounts = await ctx.storage.list('accounts')
  const put: unknown[] = []
  const audit: ReturnType<typeof auditEntry>[] = []
  for (const p of chosen) {
    const acc = accounts.find((a) => a.id === p.accountId)!
    // buildTransaction проверяет «одна начальная»: создаём как обычную корректировку и помечаем начальной после
    const built = await buildTransaction(ctx, {
      accountId: acc.id, bookedAt: p.openingAt, type: 'adjustment', amountMinor: p.openingMinor, comment: 'Начальный остаток (из выписки)',
    }, acc).catch((e) => { throw e })
    const opening = { ...built, isOpening: true }
    put.push(opening)
    audit.push(transactionAudit(ctx, 'opening_created', opening))
    if (p.kind === 'move') {
      const old = (await ctx.storage.getTransaction(p.oldOpeningId!)) ?? fail('NOT_FOUND', 'прежний начальный остаток не найден')
      await assertUnlocked(ctx, acc, old.bookedAt)
      const now = ctx.now().toISOString()
      let next
      if (p.gapMinor === 0) next = { ...old, isOpening: false, deletedAt: now, updatedAt: now }
      else {
        const tz = await accountTimeZone(ctx, acc)
        const periodEnd = st.accounts.find((a) => a.key === p.accountKey)!.periodEnd
        const at = new Date(Math.max(Date.parse(old.bookedAt), endOfLocalDayMs(periodEnd, tz) + 1)).toISOString()
        await assertUnlocked(ctx, acc, at)
        next = { ...old, isOpening: false, amountMinor: p.gapMinor!, bookedAt: at, comment: 'Неучтённая разница между выписками', updatedAt: now }
      }
      put.push(next)
      audit.push(transactionAudit(ctx, p.gapMinor === 0 ? 'opening_removed' : 'opening_to_adjustment', next, old))
    }
  }
  await ctx.storage.applyBatch({ put: { transactions: put }, audit } as never)
  return chosen.length
}
