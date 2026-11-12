import { describe, expect, it } from 'vitest'
import {
  addCheckpoint, closePeriod, createTransaction, getCheckpointDiffs, invalidateCheckpoint, reopenPeriod,
  softDeleteTransaction, updateTransaction,
} from '../src/core'
import { code, ID, setup } from './helpers'

const mk = (ctx: Awaited<ReturnType<typeof setup>>['ctx'], at: string, amt = 100, extra = {}) =>
  createTransaction(ctx, { accountId: ID.space, bookedAt: at, type: 'income', amountMinor: amt, ...extra })

describe('закрытие периодов', () => {
  it('до даты закрытия менять нельзя (вставка, правка, удаление, точка), после можно', async () => {
    const { ctx } = await setup()
    const t = await mk(ctx, '2026-10-10T10:00:00Z')
    await closePeriod(ctx, { through: '2026-10-31' })
    expect(await code(mk(ctx, '2026-10-20T10:00:00Z'))).toBe('PERIOD_LOCKED')
    expect(await code(updateTransaction(ctx, t.id, { comment: 'x' }))).toBe('PERIOD_LOCKED')
    expect(await code(softDeleteTransaction(ctx, t.id))).toBe('PERIOD_LOCKED')
    expect(await code(addCheckpoint(ctx, { accountId: ID.space, asOf: '2026-10-31T12:00:00Z', balanceMinor: 100 }))).toBe('PERIOD_LOCKED')
    expect(await code(mk(ctx, '2026-11-02T10:00:00Z'))).toBe('NO_ERROR')
    // нельзя перенести новую запись в закрытый период
    const n = await mk(ctx, '2026-11-03T10:00:00Z')
    expect(await code(updateTransaction(ctx, n.id, { bookedAt: '2026-10-15T10:00:00Z' }))).toBe('PERIOD_LOCKED')
  })
  it('граница в поясе счёта', async () => {
    const { ctx } = await setup()
    await closePeriod(ctx, { through: '2026-10-31' })
    expect(await code(mk(ctx, '2026-10-31T22:30:00Z'))).toBe('PERIOD_LOCKED')   // 23:30 31 окт в Братиславе
    expect(await code(mk(ctx, '2026-10-31T23:30:00Z'))).toBe('NO_ERROR')        // уже 1 ноября
  })
  it('закрытие общее: действует на счета всех разделов', async () => {
    const { ctx } = await setup()
    await closePeriod(ctx, { through: '2026-10-31' })
    expect(await code(createTransaction(ctx, { accountId: ID.mono, bookedAt: '2026-10-10T10:00:00Z', type: 'income', amountMinor: 5 }))).toBe('PERIOD_LOCKED')
    expect(await code(createTransaction(ctx, { accountId: ID.space, bookedAt: '2026-10-10T10:00:00Z', type: 'income', amountMinor: 5 }))).toBe('PERIOD_LOCKED')
    expect(await code(createTransaction(ctx, { accountId: ID.mono, bookedAt: '2026-11-10T10:00:00Z', type: 'income', amountMinor: 5 }))).toBe('NO_ERROR')
  })
  it('очищает raw, оставляет dedupe_hash; помеченные: оставить или удалить насовсем', async () => {
    const { ctx, storage } = await setup()
    const a = await mk(ctx, '2026-10-10T10:00:00Z', 100, { raw: { iban: 'x' }, dedupeHash: 'h1' })
    const b = await mk(ctx, '2026-10-11T10:00:00Z', 200, { raw: { iban: 'y' }, dedupeHash: 'h2' })
    const after = await mk(ctx, '2026-11-05T10:00:00Z', 300, { raw: { keep: 1 } })
    await softDeleteTransaction(ctx, b.id)
    const r = await closePeriod(ctx, { through: '2026-10-31', purgeDeleted: true })
    expect(r).toMatchObject({ purged: 1, rawCleared: 1 })
    expect(await storage.getTransaction(b.id)).toBeNull()
    const ta = (await storage.getTransaction(a.id))!
    expect(ta.raw).toBeNull(); expect(ta.dedupeHash).toBe('h1')
    expect((await storage.getTransaction(after.id))!.raw).toEqual({ keep: 1 })
  })
  it('помеченные остаются, если не просили удалять', async () => {
    const { ctx, storage } = await setup()
    const a = await mk(ctx, '2026-10-10T10:00:00Z')
    await softDeleteTransaction(ctx, a.id)
    await closePeriod(ctx, { through: '2026-10-31' })
    expect((await storage.getTransaction(a.id))!.deletedAt).not.toBeNull()
  })
  it('новая дата закрытия должна быть позже текущей; закрывает и открывает только владелец', async () => {
    const { ctx } = await setup()
    await closePeriod(ctx, { through: '2026-10-31' })
    expect(await code(closePeriod(ctx, { through: '2026-10-31' }))).toBe('PERIOD_NOT_AFTER_LOCK')
    expect(await code(closePeriod(ctx, { through: '2026-10-15' }))).toBe('PERIOD_NOT_AFTER_LOCK')
    const viewer = { ...ctx, actor: { userId: 'u2', isOwner: false } }
    expect(await code(closePeriod(viewer, { through: '2026-11-30' }))).toBe('FORBIDDEN')
    expect(await code(reopenPeriod(viewer, { steps: 1, reason: 'r' }))).toBe('FORBIDDEN')
  })
  it('расхождение с контрольной точкой блокирует закрытие, если не разрешено явно', async () => {
    const { ctx } = await setup()
    await mk(ctx, '2026-10-10T10:00:00Z', 100)
    await addCheckpoint(ctx, { accountId: ID.space, asOf: '2026-10-20T10:00:00Z', balanceMinor: 150 })
    expect(await code(closePeriod(ctx, { through: '2026-10-31' }))).toBe('CHECKPOINT_MISMATCH')
    const d = await getCheckpointDiffs(ctx)
    expect(d[0]).toMatchObject({ checkpointMinor: 150, calculatedMinor: 100, diffMinor: 50 })
    expect(await code(closePeriod(ctx, { through: '2026-10-31', allowMismatch: true }))).toBe('NO_ERROR')
  })
  it('ошибочная точка не участвует в сверке', async () => {
    const { ctx } = await setup()
    await mk(ctx, '2026-10-10T10:00:00Z', 100)
    const cp = await addCheckpoint(ctx, { accountId: ID.space, asOf: '2026-10-20T10:00:00Z', balanceMinor: 150 })
    await invalidateCheckpoint(ctx, cp.id)
    expect(await getCheckpointDiffs(ctx)).toEqual([])
    expect(await getCheckpointDiffs(ctx, { includeInvalid: true })).toHaveLength(1)
    expect(await code(closePeriod(ctx, { through: '2026-10-31' }))).toBe('NO_ERROR')
  })
  it('оценка портфеля не сверяется с расчётом', async () => {
    const { ctx } = await setup()
    await addCheckpoint(ctx, { accountId: ID.freedom, asOf: '2026-10-20T10:00:00Z', balanceMinor: 24610, kind: 'portfolio_value' })
    expect(await getCheckpointDiffs(ctx)).toEqual([])
  })
  it('открытие: шаги, причина, история сохраняется, после открытия правки снова возможны; всё в журнале', async () => {
    const { ctx, storage } = await setup()
    await closePeriod(ctx, { through: '2026-09-30' })
    await closePeriod(ctx, { through: '2026-10-31' })
    expect(await code(reopenPeriod(ctx, { steps: 1, reason: ' ' }))).toBe('INVALID_FIELD')
    expect(await code(reopenPeriod(ctx, { steps: 3, reason: 'r' }))).toBe('NOTHING_TO_REOPEN')
    expect(await reopenPeriod(ctx, { steps: 1, reason: 'исправить' })).toEqual({ lockedThrough: '2026-09-30' })
    expect(await code(mk(ctx, '2026-10-20T10:00:00Z'))).toBe('NO_ERROR')
    expect(await code(mk(ctx, '2026-09-20T10:00:00Z'))).toBe('PERIOD_LOCKED')
    expect(await reopenPeriod(ctx, { steps: 1, reason: 'ещё' })).toEqual({ lockedThrough: null })
    const locks = await storage.listPeriodLocks()
    expect(locks.map((l) => [l.seq, l.status])).toEqual([[1, 'released'], [2, 'released']])
    expect((await storage.listAudit()).map((a) => a.action).filter((x) => x.startsWith('period'))).toEqual(
      ['period_reopened', 'period_reopened', 'period_closed', 'period_closed'])
  })
})
