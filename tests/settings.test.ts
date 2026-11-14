import { describe, expect, it } from 'vitest'
import {
  createTransaction, fxFreshness, getSnapshot, readSettings, refreshFxRates, sectionTotals, setBaseCurrency,
  type BankPair, type RateSource,
} from '../src/core'
import { ID, code, rate, setup } from './helpers'

const date = '2026-11-13'
const base = async (s: Awaited<ReturnType<typeof setup>>) => readSettings(await s.storage.list('appSettings')).baseCurrency
const open = (s: Awaited<ReturnType<typeof setup>>, accountId: string, currencyKey: string, minor: number) =>
  createTransaction(s.ctx, { accountId, type: 'adjustment', bookedAt: '2026-11-01T10:00:00Z', amountMinor: minor, currencyKey, isOpening: true })

describe('setBaseCurrency', () => {
  it('меняет базовую валюту и пишет в журнал', async () => {
    const s = await setup()
    await setBaseCurrency(s.ctx, 'usd')
    expect(await base(s)).toBe('usd')
    const log = await s.storage.listAudit({})
    expect(log.some((a) => a.action === 'setting_changed' && a.newData === 'usd' && a.oldData === 'eur')).toBe(true)
  })
  it('та же валюта: ничего не пишет', async () => {
    const s = await setup()
    await setBaseCurrency(s.ctx, 'eur')
    expect((await s.storage.listAudit({})).some((a) => a.action === 'setting_changed')).toBe(false)
  })
  it('не владелец: FORBIDDEN; неизвестная и не из списка: ошибки', async () => {
    const s = await setup({ owner: false })
    expect(await code(setBaseCurrency(s.ctx, 'usd'))).toBe('FORBIDDEN')
    const o = await setup()
    expect(await code(setBaseCurrency(o.ctx, 'pln'))).toBe('INVALID_FIELD')
    await o.storage.applyBatch({ put: { currencies: [{ key: 'chf', code: 'CHF', name: null, decimals: 2 }] } })
    expect(await code(setBaseCurrency(o.ctx, 'chf'))).toBe('INVALID_FIELD')
  })
  it('итоги и «≈» пересчитываются в новую базовую валюту', async () => {
    const s = await setup()
    await s.storage.applyBatch({ put: { fxRates: [rate('r1', date, 'eur', 'uah', '50'), rate('r2', date, 'eur', 'usd', '1.25')], appSettings: [{ key: 'fx_pivot_currency', value: 'eur' }] } })
    await open(s, ID.cashUah, 'uah', 500000)   // 5000 UAH
    await setBaseCurrency(s.ctx, 'usd')
    const snap = await getSnapshot(s.ctx, { date })
    expect(snap.totals.baseCurrency).toBe('usd')
    expect(snap.rows.find((r) => r.accountId === ID.cashUah)!.balance.minor).toBe(12500)   // 5000 UAH = 100 EUR = 125 USD
  })
  it('после смены базовой валюты недостающие курсы запрашиваются автообновлением', async () => {
    const s = await setup()
    await s.storage.applyBatch({ put: { fxRates: [rate('r1', date, 'eur', 'uah', '50')] } })
    await open(s, ID.cashUah, 'uah', 500000)
    await setBaseCurrency(s.ctx, 'usd')
    expect((await fxFreshness(s.ctx, date)).stale).toEqual(['eur', 'uah'])
    const pairs: BankPair[] = [{ a: 'USD', b: 'UAH', buy: 41.5, sell: 42 }, { a: 'EUR', b: 'USD', buy: 1.15, sell: 1.17 }]
    const src: RateSource = { source: 'monobank', fetchPairs: async () => pairs }
    expect((await refreshFxRates(s.ctx, date, [src])).status).toBe('updated')
    expect((await getSnapshot(s.ctx, { date })).totals.complete).toBe(true)
  })
})

describe('sectionTotals', () => {
  it('итог по разделу в базовой валюте; без курса complete = false', async () => {
    const s = await setup()
    await s.storage.applyBatch({ put: { fxRates: [rate('r1', date, 'eur', 'uah', '50')] } })
    await open(s, ID.space, 'eur', 10000)       // личное: 100 EUR
    await open(s, ID.cashUah, 'uah', 500000)    // личное: 5000 UAH = 100 EUR
    await open(s, ID.freedom, 'usd', 1000)      // личное: USD без курса
    await open(s, ID.mono, 'uah', 100000)       // бизнес: 1000 UAH = 20 EUR
    const t = sectionTotals(await getSnapshot(s.ctx, { date }))
    expect(t.get(ID.biznes)).toMatchObject({ baseMinor: 2000, complete: true })
    expect(t.get(ID.lichnoe)).toMatchObject({ baseMinor: 20000, complete: false, missingRateCurrencies: ['usd'] })
  })
  it('раздел с нулевыми счетами даёт 0, а не пропадает', async () => {
    const s = await setup()
    await s.storage.applyBatch({ put: { fxRates: [rate('r1', date, 'eur', 'uah', '50')] } })
    expect(sectionTotals(await getSnapshot(s.ctx, { date })).get(ID.biznes)).toMatchObject({ baseMinor: 0, complete: true })
  })
})
