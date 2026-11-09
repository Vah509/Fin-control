import { describe, expect, it } from 'vitest'
import { commitBalanceEntry, createTransaction, getCheckpointDiffs, getSnapshot, previewBalanceEntry } from '../src/core'
import { code, ID, setup } from './helpers'

describe('форма ввода остатка', () => {
  it('первый ввод по пустому счёту создаёт начальную корректировку и точку', async () => {
    const { ctx, storage } = await setup()
    const asOf = '2026-09-30T22:00:00Z'
    const p = await previewBalanceEntry(ctx, { accountId: ID.space, asOf, newBalanceMinor: 124558 })
    expect(p).toMatchObject({ previousMinor: null, calculatedMinor: 0, diffMinor: 124558, willBeOpening: true })
    const r = await commitBalanceEntry(ctx, { accountId: ID.space, asOf, newBalanceMinor: 124558, createAdjustment: true })
    expect(r.adjustment).toMatchObject({ isOpening: true, type: 'adjustment', amountMinor: 124558 })
    expect((await storage.listCheckpoints())[0]).toMatchObject({ balanceMinor: 124558, status: 'active' })
    expect((await getSnapshot(ctx, { date: '2026-10-01', accountIds: [ID.space] })).rows[0]!.balanceMinor).toBe(124558)
  })
  it('нулевой остаток по пустому счёту: только точка, без нулевой корректировки', async () => {
    const { ctx } = await setup()
    const r = await commitBalanceEntry(ctx, { accountId: ID.space, asOf: '2026-10-25T00:00:00Z', newBalanceMinor: 0 })
    expect(r.adjustment).toBeNull()
  })
  it('«только остатки»: корректировка на разницу создаётся сразу', async () => {
    const { ctx } = await setup()
    await commitBalanceEntry(ctx, { accountId: ID.parents, asOf: '2026-10-01T10:00:00Z', newBalanceMinor: 35000 })
    const r = await commitBalanceEntry(ctx, { accountId: ID.parents, asOf: '2026-10-15T10:00:00Z', newBalanceMinor: 30000 })
    expect(r.adjustment).toMatchObject({ amountMinor: -5000, isOpening: false })
    const s = await getSnapshot(ctx, { date: '2026-10-31', accountIds: [ID.parents] })
    expect(s.rows[0]).toMatchObject({ balanceMinor: 30000, unaccountedMinor: -5000 })
    const p = await previewBalanceEntry(ctx, { accountId: ID.parents, asOf: '2026-10-20T10:00:00Z', newBalanceMinor: 30000 })
    expect(p).toMatchObject({ previousMinor: 30000, diffMinor: 0, adjustmentRequired: true })
  })
  it('«остатки и движения»: корректировка только по подтверждению; без неё остаётся видимое расхождение', async () => {
    const { ctx } = await setup()
    await createTransaction(ctx, { accountId: ID.space, bookedAt: '2026-10-01T10:00:00Z', type: 'income', amountMinor: 10000 })
    const r1 = await commitBalanceEntry(ctx, { accountId: ID.space, asOf: '2026-10-10T10:00:00Z', newBalanceMinor: 9000 })
    expect(r1.adjustment).toBeNull()
    expect((await getCheckpointDiffs(ctx))[0]!.diffMinor).toBe(-1000)
    const r2 = await commitBalanceEntry(ctx, { accountId: ID.space, asOf: '2026-10-11T10:00:00Z', newBalanceMinor: 9000, createAdjustment: true })
    expect(r2.adjustment).toMatchObject({ amountMinor: -1000 })
    expect((await getCheckpointDiffs(ctx)).map((d) => d.diffMinor)).toEqual([-1000, 0])
  })
  it('остаток может быть отрицательным; в закрытый период вводить нельзя', async () => {
    const { ctx } = await setup()
    await commitBalanceEntry(ctx, { accountId: ID.space, asOf: '2026-10-01T10:00:00Z', newBalanceMinor: -2500, createAdjustment: true })
    expect((await getSnapshot(ctx, { date: '2026-10-02', accountIds: [ID.space] })).rows[0]!.balanceMinor).toBe(-2500)
    const { closePeriod } = await import('../src/core')
    await closePeriod(ctx, { projectId: ID.lichnoe, through: '2026-10-31', allowMismatch: true })
    expect(await code(commitBalanceEntry(ctx, { accountId: ID.space, asOf: '2026-10-15T10:00:00Z', newBalanceMinor: 0 }))).toBe('PERIOD_LOCKED')
  })
})
