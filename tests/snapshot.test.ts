import { describe, expect, it } from 'vitest'
import { createTransaction, getSnapshot, getUnaccounted, groupSnapshot, setAccountArchived } from '../src/core'
import { ID, rate, setup } from './helpers'

describe('срез на дату', () => {
  it('начальный остаток 1 октября 00:00 Братиславы виден на 1 октября, но не на 30 сентября', async () => {
    const { ctx } = await setup()
    await createTransaction(ctx, { accountId: ID.space, bookedAt: '2026-09-30T22:00:00Z', type: 'adjustment', amountMinor: 124558, isOpening: true })
    const a = await getSnapshot(ctx, { date: '2026-09-30', accountIds: [ID.space] })
    const b = await getSnapshot(ctx, { date: '2026-10-01', accountIds: [ID.space] })
    expect(a.rows[0]!.balanceMinor).toBe(0)
    expect(b.rows[0]!.balanceMinor).toBe(124558)
  })
  it('конец дня считается в поясе счёта', async () => {
    const { ctx } = await setup()
    // 23:30Z 31 октября: в Братиславе уже 1 ноября
    await createTransaction(ctx, { accountId: ID.space, bookedAt: '2026-10-31T23:30:00Z', type: 'income', amountMinor: 100 })
    expect((await getSnapshot(ctx, { date: '2026-10-31', accountIds: [ID.space] })).rows[0]!.balanceMinor).toBe(0)
    expect((await getSnapshot(ctx, { date: '2026-11-01', accountIds: [ID.space] })).rows[0]!.balanceMinor).toBe(100)
  })
  it('страна «Без страны» берёт пояс из настройки default_timezone', async () => {
    const { ctx } = await setup()
    await createTransaction(ctx, { accountId: ID.freedom, bookedAt: '2026-10-31T23:30:00Z', type: 'adjustment', amountMinor: 500 })
    expect((await getSnapshot(ctx, { date: '2026-10-31', accountIds: [ID.freedom] })).rows[0]!.balanceMinor).toBe(0)
    expect((await getSnapshot(ctx, { date: '2026-11-01', accountIds: [ID.freedom] })).rows[0]!.balanceMinor).toBe(500)
  })
  it('итоги: по валютам и в базовой валюте; «нет курса» помечается, а не считается нулём', async () => {
    const { ctx, storage } = await setup()
    await createTransaction(ctx, { accountId: ID.space, bookedAt: '2026-10-01T10:00:00Z', type: 'income', amountMinor: 10000 })
    await createTransaction(ctx, { accountId: ID.cashUah, bookedAt: '2026-10-01T10:00:00Z', type: 'income', amountMinor: 100000 })
    await createTransaction(ctx, { accountId: ID.freedom, bookedAt: '2026-10-01T10:00:00Z', type: 'adjustment', amountMinor: 20000 })
    await storage.applyBatch({ put: { fxRates: [rate('r1', '2026-10-01', 'eur', 'uah', '40')] } })
    const s = await getSnapshot(ctx, { date: '2026-10-05' })
    expect(s.totals.byCurrency.map((c) => [c.currencyKey, c.balanceMinor])).toEqual([['eur', 10000], ['uah', 100000], ['usd', 20000]])
    expect(s.totals.baseMinor).toBe(10000 + 2500)         // 1000 UAH / 40 = 25 EUR
    expect(s.totals.complete).toBe(false)
    expect(s.totals.missingRateCurrencies).toEqual(['usd'])
    expect(s.rows.find((r) => r.accountId === ID.freedom)!.balance).toEqual({ minor: null, hasRate: false })
    await storage.applyBatch({ put: { fxRates: [rate('r2', '2026-10-02', 'eur', 'usd', '1.25')] } })
    const s2 = await getSnapshot(ctx, { date: '2026-10-05' })
    expect(s2.totals.complete).toBe(true)
    expect(s2.totals.baseMinor).toBe(10000 + 2500 + 16000)
  })
  it('каждый счёт округляется отдельно', async () => {
    const { ctx, storage } = await setup()
    await createTransaction(ctx, { accountId: ID.cashUah, bookedAt: '2026-10-01T10:00:00Z', type: 'income', amountMinor: 10 })
    await createTransaction(ctx, { accountId: ID.mono, bookedAt: '2026-10-01T10:00:00Z', type: 'income', amountMinor: 10 })
    await storage.applyBatch({ put: { fxRates: [rate('r1', '2026-10-01', 'uah', 'eur', '0.025')] } })
    const s = await getSnapshot(ctx, { date: '2026-10-05', accountIds: [ID.cashUah, ID.mono] })
    expect(s.rows.map((r) => r.balance.minor)).toEqual([0, 0]) // 0.0025 EUR каждый
    expect(s.totals.baseMinor).toBe(0)
  })
  it('корректировки показываются отдельно как «неучтённое», начальная не входит', async () => {
    const { ctx } = await setup()
    await createTransaction(ctx, { accountId: ID.parents, bookedAt: '2026-10-01T10:00:00Z', type: 'adjustment', amountMinor: 300000, isOpening: true })
    await createTransaction(ctx, { accountId: ID.parents, bookedAt: '2026-10-10T10:00:00Z', type: 'adjustment', amountMinor: -5000 })
    const s = await getSnapshot(ctx, { date: '2026-10-31', accountIds: [ID.parents] })
    expect(s.rows[0]!.balanceMinor).toBe(295000)
    expect(s.rows[0]!.unaccountedMinor).toBe(-5000)
    const per = await getUnaccounted(ctx, { from: '2026-10-01', to: '2026-10-31' })
    expect(per).toHaveLength(1)
    expect(per[0]!.minor).toBe(-5000)
    expect(await getUnaccounted(ctx, { from: '2026-10-11', to: '2026-10-31' })).toEqual([])
  })
  it('отрицательные остатки допустимы; архивный нулевой счёт скрывается после архивации', async () => {
    const { ctx, storage } = await setup()
    await createTransaction(ctx, { accountId: ID.space, bookedAt: '2026-10-01T10:00:00Z', type: 'expense', amountMinor: -700 })
    expect((await getSnapshot(ctx, { date: '2026-10-02', accountIds: [ID.space] })).rows[0]!.balanceMinor).toBe(-700)
    ctx.now = () => new Date('2026-10-20T10:00:00Z')
    await setAccountArchived(ctx, ID.cashUah, true)
    expect((await getSnapshot(ctx, { date: '2026-10-19', accountIds: [ID.cashUah] })).rows).toHaveLength(1)
    expect((await getSnapshot(ctx, { date: '2026-10-21', accountIds: [ID.cashUah] })).rows).toHaveLength(0)
    void storage
  })
  it('фильтр по проекту и группировка', async () => {
    const { ctx } = await setup()
    await createTransaction(ctx, { accountId: ID.space, bookedAt: '2026-10-01T10:00:00Z', type: 'income', amountMinor: 100 })
    await createTransaction(ctx, { accountId: ID.parents, bookedAt: '2026-10-01T10:00:00Z', type: 'adjustment', amountMinor: 200 })
    const biz = await getSnapshot(ctx, { date: '2026-10-05', projectIds: [ID.biznes] })
    expect(biz.rows.map((r) => r.accountId)).toEqual([ID.mono])
    const all = await getSnapshot(ctx, { date: '2026-10-05', accountIds: [ID.space, ID.parents] })
    const g = groupSnapshot(all, 'country')
    expect(g.map((x) => [x.groupKey, x.totals.baseMinor]).sort()).toEqual([['sk', 100], ['ua', 200]])
  })
})
