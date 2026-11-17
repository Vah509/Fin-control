import { describe, expect, it } from 'vitest'
import { addCheckpoint, closePeriod, createTransaction, getCheckpointDiffs, getEnteredSnapshot, getSnapshot, invalidateCheckpoint, lastEnteredBalances, saveEnteredBalance } from '../src/core'
import { code, ID, setup } from './helpers'

describe('учёт остатками (точки entered)', () => {
  it('сохраняет только точку: ни операций, ни корректировок, срез по движениям не меняется', async () => {
    const { ctx, storage } = await setup()
    await saveEnteredBalance(ctx, { accountId: ID.space, date: '2026-10-31', balanceMinor: 124558 })
    expect(await storage.listTransactions({ accountId: ID.space })).toHaveLength(0)
    const cps = await storage.listCheckpoints()
    expect(cps).toHaveLength(1)
    expect(cps[0]).toMatchObject({ kind: 'entered', balanceMinor: 124558, status: 'active', source: 'manual' })
    expect((await getSnapshot(ctx, { date: '2026-11-09', accountIds: [ID.space] })).rows[0]!.balanceMinor).toBe(0)
  })
  it('точки entered не дают расхождений с расчётом и не мешают закрытию периода', async () => {
    const { ctx } = await setup()
    await createTransaction(ctx, { accountId: ID.space, bookedAt: '2026-10-01T10:00:00Z', type: 'income', amountMinor: 10000 })
    await saveEnteredBalance(ctx, { accountId: ID.space, date: '2026-10-31', balanceMinor: 55555 })
    expect(await getCheckpointDiffs(ctx)).toEqual([])
    await expect(closePeriod(ctx, { through: '2026-10-31' })).resolves.toBeDefined()
  })
  it('последний остаток: самая поздняя дата, при равных датах более поздняя запись; ошибочные не считаются', async () => {
    const { ctx, clock } = await setup()
    await saveEnteredBalance(ctx, { accountId: ID.space, date: '2026-09-30', balanceMinor: 100 })
    await saveEnteredBalance(ctx, { accountId: ID.space, date: '2026-10-31', balanceMinor: 200 })
    await saveEnteredBalance(ctx, { accountId: ID.space, date: '2026-08-31', balanceMinor: 999 })   // раньше по дате, но введён позже
    let last = await lastEnteredBalances(ctx)
    expect(last.get(ID.space)).toMatchObject({ balanceMinor: 200, date: '2026-10-31' })
    clock.t += 1000
    const again = await saveEnteredBalance(ctx, { accountId: ID.space, date: '2026-10-31', balanceMinor: 300 })
    last = await lastEnteredBalances(ctx)
    expect(last.get(ID.space)!.balanceMinor).toBe(300)
    await invalidateCheckpoint(ctx, again.id)
    last = await lastEnteredBalances(ctx)
    expect(last.get(ID.space)!.balanceMinor).toBe(200)
  })
  it('точки формы ввода остатка (balance) в учёт остатками не попадают', async () => {
    const { ctx } = await setup()
    await addCheckpoint(ctx, { accountId: ID.space, asOf: '2026-10-31T10:00:00Z', balanceMinor: 777 })
    expect((await lastEnteredBalances(ctx)).size).toBe(0)
  })
  it('срез по остаткам: суммы, пересчёт в базовую валюту, «нет данных», движения не участвуют', async () => {
    const { ctx } = await setup()
    await createTransaction(ctx, { accountId: ID.space, bookedAt: '2026-10-01T10:00:00Z', type: 'income', amountMinor: 5000 })
    await saveEnteredBalance(ctx, { accountId: ID.space, date: '2026-10-31', balanceMinor: 120000 })
    const e = await getEnteredSnapshot(ctx, { rateDate: '2026-11-09', accountIds: [ID.space, ID.cashUah] })
    expect(e.rows).toHaveLength(1)
    expect(e.rows[0]).toMatchObject({ accountId: ID.space, balanceMinor: 120000, unaccountedMinor: 0 })
    expect(e.dateByAccount[ID.space]).toBe('2026-10-31')
    expect(e.missing).toEqual([ID.cashUah])
    expect(e.totals.baseMinor).toBe(120000)
  })
  it('отрицательный остаток допустим; закрытый период и архивный счёт не принимают', async () => {
    const { ctx } = await setup()
    await saveEnteredBalance(ctx, { accountId: ID.space, date: '2026-10-05', balanceMinor: -2500 })
    expect((await lastEnteredBalances(ctx)).get(ID.space)!.balanceMinor).toBe(-2500)
    await closePeriod(ctx, { through: '2026-10-31', allowMismatch: true })
    expect(await code(saveEnteredBalance(ctx, { accountId: ID.space, date: '2026-10-20', balanceMinor: 1 }))).toBe('PERIOD_LOCKED')
    await saveEnteredBalance(ctx, { accountId: ID.space, date: '2026-11-05', balanceMinor: 1 })
  })
  it('неверная дата и неизвестный счёт отклоняются', async () => {
    const { ctx } = await setup()
    expect(await code(saveEnteredBalance(ctx, { accountId: ID.space, date: '2026-13-40', balanceMinor: 1 }))).toBe('INVALID_DATE')
    expect(await code(saveEnteredBalance(ctx, { accountId: 'нет', date: '2026-10-31', balanceMinor: 1 }))).toBe('NOT_FOUND')
  })
})
