import { describe, expect, it } from 'vitest'
import {
  balanceAt, createTransaction, restoreTransaction, softDeleteTransaction, updateTransaction,
} from '../src/core'
import { code, ID, setup } from './helpers'

const base = { accountId: ID.space, bookedAt: '2026-10-05T10:00:00Z' }

describe('проверки операции', () => {
  it('знак суммы по типу', async () => {
    const { ctx } = await setup()
    expect(await code(createTransaction(ctx, { ...base, type: 'income', amountMinor: -100 }))).toBe('INVALID_SIGN')
    expect(await code(createTransaction(ctx, { ...base, type: 'expense', amountMinor: 100 }))).toBe('INVALID_SIGN')
    expect(await code(createTransaction(ctx, { ...base, type: 'fee', amountMinor: 100 }))).toBe('INVALID_SIGN')
    expect(await code(createTransaction(ctx, { ...base, type: 'income', amountMinor: 100 }))).toBe('NO_ERROR')
    expect(await code(createTransaction(ctx, { ...base, type: 'expense', amountMinor: -100 }))).toBe('NO_ERROR')
    expect(await code(createTransaction(ctx, { ...base, type: 'transfer', amountMinor: -100 }))).toBe('NO_ERROR')
    expect(await code(createTransaction(ctx, { ...base, type: 'transfer', amountMinor: 100 }))).toBe('NO_ERROR')
  })
  it('ноль и дробные суммы запрещены', async () => {
    const { ctx } = await setup()
    expect(await code(createTransaction(ctx, { ...base, type: 'adjustment', amountMinor: 0 }))).toBe('INVALID_AMOUNT')
    expect(await code(createTransaction(ctx, { ...base, type: 'income', amountMinor: 1.5 }))).toBe('INVALID_AMOUNT')
  })
  it('валюта равна валюте счёта', async () => {
    const { ctx } = await setup()
    expect(await code(createTransaction(ctx, { ...base, type: 'income', amountMinor: 100, currencyKey: 'usd' }))).toBe('CURRENCY_MISMATCH')
    const t = await createTransaction(ctx, { ...base, type: 'income', amountMinor: 100 })
    expect(t.currencyKey).toBe('eur')
  })
  it('исходные сумма и валюта: парой и с тем же знаком', async () => {
    const { ctx } = await setup()
    const o = { ...base, type: 'expense' as const, amountMinor: -1000 }
    expect(await code(createTransaction(ctx, { ...o, originalAmountMinor: -1200 }))).toBe('INVALID_ORIGINAL')
    expect(await code(createTransaction(ctx, { ...o, originalAmountMinor: 1200, originalCurrencyKey: 'usd' }))).toBe('INVALID_ORIGINAL')
    const t = await createTransaction(ctx, { ...o, originalAmountMinor: -1200, originalCurrencyKey: 'usd' })
    expect(t.originalAmountMinor).toBe(-1200)
  })
  it('архивный счёт не принимает операции', async () => {
    const { ctx, storage } = await setup()
    const acc = (await storage.list('accounts')).find((a) => a.id === ID.space)!
    await storage.applyBatch({ put: { accounts: [{ ...acc, archivedAt: '2026-10-01T00:00:00Z' }] } })
    expect(await code(createTransaction(ctx, { ...base, type: 'income', amountMinor: 100 }))).toBe('ACCOUNT_ARCHIVED')
  })
  it('неизвестная плановость отвергается', async () => {
    const { ctx } = await setup()
    expect(await code(createTransaction(ctx, { ...base, type: 'income', amountMinor: 1, planType: 'x' }))).toBe('INVALID_FIELD')
    expect(await code(createTransaction(ctx, { ...base, type: 'income', amountMinor: 1, planType: 'planned' }))).toBe('NO_ERROR')
  })
  it('одна начальная корректировка на счёт; начальная только корректировка', async () => {
    const { ctx } = await setup()
    const o = { ...base, type: 'adjustment' as const, amountMinor: 100, isOpening: true }
    expect(await code(createTransaction(ctx, { ...base, type: 'income', amountMinor: 100, isOpening: true }))).toBe('OPENING_NOT_ADJUSTMENT')
    expect(await code(createTransaction(ctx, o))).toBe('NO_ERROR')
    expect(await code(createTransaction(ctx, o))).toBe('OPENING_EXISTS')
  })
  it('корректировки и начальные пишутся в журнал, обычные операции нет; raw в журнал не попадает', async () => {
    const { ctx, storage } = await setup()
    await createTransaction(ctx, { ...base, type: 'income', amountMinor: 100, raw: { secret: 1 } })
    await createTransaction(ctx, { ...base, type: 'adjustment', amountMinor: 50, isOpening: true, raw: { secret: 2 } })
    const log = await storage.listAudit()
    expect(log.map((l) => l.action)).toEqual(['opening_created'])
    expect(JSON.stringify(log[0])).not.toContain('secret')
  })
})

describe('изменение и удаление', () => {
  it('мягкое удаление выпадает из расчёта, восстановление возвращает', async () => {
    const { ctx, storage } = await setup()
    const acc = (await storage.list('accounts')).find((a) => a.id === ID.space)!
    const t = await createTransaction(ctx, { ...base, type: 'income', amountMinor: 500 })
    const at = Date.parse('2026-12-01T00:00:00Z')
    expect(await balanceAt(ctx, acc, at)).toBe(500)
    await softDeleteTransaction(ctx, t.id)
    expect(await balanceAt(ctx, acc, at)).toBe(0)
    expect(await code(updateTransaction(ctx, t.id, { comment: 'x' }))).toBe('NOT_FOUND')
    await restoreTransaction(ctx, t.id)
    expect(await balanceAt(ctx, acc, at)).toBe(500)
  })
  it('правка проверяет те же правила', async () => {
    const { ctx } = await setup()
    const t = await createTransaction(ctx, { ...base, type: 'income', amountMinor: 500 })
    expect(await code(updateTransaction(ctx, t.id, { amountMinor: -5 }))).toBe('INVALID_SIGN')
    const u = await updateTransaction(ctx, t.id, { amountMinor: 700, comment: 'зарплата', tagId: null })
    expect(u.amountMinor).toBe(700)
    expect(u.comment).toBe('зарплата')
  })
  it('баланс считается на момент включительно', async () => {
    const { ctx, storage } = await setup()
    const acc = (await storage.list('accounts')).find((a) => a.id === ID.space)!
    await createTransaction(ctx, { ...base, type: 'income', amountMinor: 100 })
    expect(await balanceAt(ctx, acc, Date.parse('2026-10-05T09:59:59.999Z'))).toBe(0)
    expect(await balanceAt(ctx, acc, Date.parse('2026-10-05T10:00:00Z'))).toBe(100)
  })
})
