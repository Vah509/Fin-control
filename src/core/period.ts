import type { PeriodLock } from '../data/types'
import { auditEntry } from './audit'
import type { CoreContext } from './context'
import { fail } from './errors'
import { assertDate, endOfLocalDayMs, iso } from './time'
import { accountTimeZone, currentLock } from './locks'
import { getCheckpointDiffs } from './checkpoints'

export interface ClosePeriodInput {
  projectId: string
  through: string
  /** Окончательно удалить помеченные на удаление записи периода (иначе они остаются помеченными). */
  purgeDeleted?: boolean
  /** Закрыть, даже если есть расхождения с контрольными точками. По умолчанию нельзя. */
  allowMismatch?: boolean
}

export async function closePeriod(ctx: CoreContext, input: ClosePeriodInput) {
  if (!ctx.actor.isOwner) fail('FORBIDDEN', 'закрывать период может только владелец')
  assertDate(input.through, 'дата закрытия')
  const locks = await ctx.storage.listPeriodLocks(input.projectId)
  const cur = currentLock(locks)
  if (cur && input.through <= cur.lockedThrough) {
    fail('PERIOD_NOT_AFTER_LOCK', `период уже закрыт по ${cur.lockedThrough}`)
  }
  const accounts = (await ctx.storage.list('accounts')).filter((a) => a.projectId === input.projectId)
  if (!input.allowMismatch) {
    const diffs = await getCheckpointDiffs(ctx, { accountIds: accounts.map((a) => a.id), throughDate: input.through })
    const bad = diffs.filter((d) => d.diffMinor !== 0)
    if (bad.length) fail('CHECKPOINT_MISMATCH', `расхождений с контрольными точками: ${bad.length}`, { diffs: bad })
  }

  let purged = 0, rawCleared = 0
  const toPut = []
  const toDelete: string[] = []
  for (const a of accounts) {
    const tz = await accountTimeZone(ctx, a)
    const txs = await ctx.storage.listTransactions({
      accountId: a.id, includeDeleted: true, bookedTo: iso(endOfLocalDayMs(input.through, tz)),
    })
    for (const t of txs) {
      if (t.deletedAt && input.purgeDeleted) { toDelete.push(t.id); purged++; continue }
      if (t.raw !== null) { toPut.push({ ...t, raw: null, updatedAt: ctx.now().toISOString() }); rawCleared++ }
    }
  }
  const lock: PeriodLock = {
    id: ctx.newId(), seq: locks.reduce((m, l) => Math.max(m, l.seq), 0) + 1,
    projectId: input.projectId, lockedThrough: input.through, lockedAt: ctx.now().toISOString(),
    lockedBy: ctx.actor.userId, status: 'active', releasedAt: null, releasedBy: null, releaseReason: null,
  }
  await ctx.storage.applyBatch({
    put: { periodLocks: [lock], transactions: toPut },
    deleteTransactionIds: toDelete,
    audit: [auditEntry(ctx, 'period_closed', {
      tableName: 'period_locks', recordId: lock.id,
      details: { projectId: input.projectId, through: input.through, purged, rawCleared },
    })],
  })
  return { lock, purged, rawCleared }
}

export async function reopenPeriod(ctx: CoreContext, input: { projectId: string; steps: number; reason: string }) {
  if (!ctx.actor.isOwner) fail('FORBIDDEN', 'открывать период может только владелец')
  if (!input.reason.trim()) fail('INVALID_FIELD', 'нужна причина открытия')
  const locks = await ctx.storage.listPeriodLocks(input.projectId)
  const active = locks.filter((l) => l.status === 'active').sort((a, b) => b.seq - a.seq)
  if (!Number.isInteger(input.steps) || input.steps < 1 || input.steps > active.length) {
    fail('NOTHING_TO_REOPEN', `активных закрытий: ${active.length}, запрошено шагов: ${input.steps}`)
  }
  const released = active.slice(0, input.steps).map((l) => ({
    ...l, status: 'released' as const, releasedAt: ctx.now().toISOString(),
    releasedBy: ctx.actor.userId, releaseReason: input.reason.trim(),
  }))
  const before = active[0]!.lockedThrough
  const after = active[input.steps]?.lockedThrough ?? null
  await ctx.storage.applyBatch({
    put: { periodLocks: released },
    audit: [auditEntry(ctx, 'period_reopened', {
      tableName: 'period_locks', recordId: released[0]!.id,
      details: { projectId: input.projectId, steps: input.steps, from: before, to: after, reason: input.reason.trim() },
    })],
  })
  return { lockedThrough: after }
}
