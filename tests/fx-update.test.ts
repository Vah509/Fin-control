import { describe, expect, it } from 'vitest'
import {
  averageRate, createTransaction, fxFreshness, getSnapshot, refreshFxRates,
  type BankPair, type RateSource,
} from '../src/core'
import { parseMonobank, parsePrivat } from '../src/net/bankRates'
import { describeFx, shouldTry, RETRY_AFTER_MS } from '../src/ui/fxAuto'
import { ID, rate, setup } from './helpers'

const eur = { key: 'eur', code: 'EUR', name: 'Евро', decimals: 2 }
const uah = { key: 'uah', code: 'UAH', name: 'Гривна', decimals: 2 }
const usd = { key: 'usd', code: 'USD', name: 'Доллар', decimals: 2 }

// Пары в формате monobank: A/B, банк покупает A за buy и продаёт за sell.
const mono: BankPair[] = [
  { a: 'USD', b: 'UAH', buy: 41.5, sell: 42.0 },
  { a: 'EUR', b: 'UAH', buy: 48.0, sell: 48.8 },
  { a: 'EUR', b: 'USD', buy: 1.15, sell: 1.17 },
]
const privat: BankPair[] = [
  { a: 'USD', b: 'UAH', buy: 41.4, sell: 42.1 },
  { a: 'EUR', b: 'UAH', buy: 47.9, sell: 48.9 },
]
const src = (source: string, pairs: BankPair[] | Error): RateSource => ({
  source, fetchPairs: async () => { if (pairs instanceof Error) throw pairs; return pairs },
})
const today = '2026-11-13'

describe('averageRate: средний между покупкой и продажей', () => {
  it('UAH → EUR: курс продажи евро (меньше евро за гривны)', () => {
    expect(averageRate(eur, uah, mono)).toEqual({ baseKey: 'eur', quoteKey: 'uah', rate: '48.40000000' })
  })
  it('USD → EUR: пара EUR/USD, курс продажи', () => {
    expect(averageRate(eur, usd, mono)).toEqual({ baseKey: 'eur', quoteKey: 'usd', rate: '1.16000000' })
  })
  it('USD → EUR без пары EUR/USD: через гривну, покупка USD / продажа EUR', () => {
    const r = averageRate(eur, usd, privat)!
    expect(r.baseKey).toBe('usd'); expect(r.quoteKey).toBe('eur')
    expect(Number(r.rate)).toBeCloseTo(41.75 / 48.4, 6)
  })
  it('база UAH: USD → UAH по среднему', () => {
    expect(averageRate(uah, usd, mono)).toEqual({ baseKey: 'usd', quoteKey: 'uah', rate: '41.75000000' })
  })
  it('нет подходящих пар или нулевые курсы = null', () => {
    expect(averageRate(eur, usd, [])).toBeNull()
    expect(averageRate(eur, uah, [{ a: 'EUR', b: 'UAH', buy: 48, sell: 0 }])).toBeNull()
    expect(averageRate(eur, uah, [{ a: 'EUR', b: 'UAH', buy: null, sell: null }])).toBeNull()
  })
})

describe('разбор ответов банков', () => {
  it('monobank: коды ISO, пропуск rateCross и незнакомых валют', () => {
    const p = parseMonobank([
      { currencyCodeA: 840, currencyCodeB: 980, date: 1, rateBuy: 41.5, rateSell: 42 },
      { currencyCodeA: 978, currencyCodeB: 840, date: 1, rateBuy: 1.15, rateSell: 1.17 },
      { currencyCodeA: 826, currencyCodeB: 980, date: 1, rateCross: 55 },
      { currencyCodeA: 12345, currencyCodeB: 980, rateBuy: 1, rateSell: 1 },
    ])
    expect(p).toEqual([
      { a: 'USD', b: 'UAH', buy: 41.5, sell: 42 },
      { a: 'EUR', b: 'USD', buy: 1.15, sell: 1.17 },
    ])
  })
  it('ПриватБанк: строки в числа', () => {
    expect(parsePrivat([{ ccy: 'EUR', base_ccy: 'UAH', buy: '47.90000', sale: '48.90000' }, { ccy: 'RUR', base_ccy: 'UAH', buy: '0.5', sale: '0.6' }]))
      .toEqual([{ a: 'EUR', b: 'UAH', buy: 47.9, sell: 48.9 }, { a: 'RUR', b: 'UAH', buy: 0.5, sell: 0.6 }])
  })
  it('неожиданный ответ даёт ошибку', () => {
    expect(() => parseMonobank({ errText: 'Too many requests' })).toThrow()
    expect(() => parsePrivat('x')).toThrow()
  })
})

describe('refreshFxRates', () => {
  it('нет курса на сегодня: берёт monobank и сохраняет для UAH и USD', async () => {
    const { ctx, storage } = await setup()
    expect((await fxFreshness(ctx, today)).stale).toEqual(['uah', 'usd'])
    const res = await refreshFxRates(ctx, today, [src('monobank', mono), src('privatbank', privat)])
    expect(res).toMatchObject({ status: 'updated', sources: ['monobank'], missing: [] })
    const rows = await storage.listFxRates()
    expect(rows.map((r) => `${r.baseCurrencyKey}>${r.quoteCurrencyKey}=${r.rate}@${r.rateDate}/${r.source}`).sort()).toEqual([
      'eur>uah=48.40000000@2026-11-13/monobank', 'eur>usd=1.16000000@2026-11-13/monobank',
    ])
  })
  it('курс на сегодня уже есть: сеть не вызывается', async () => {
    const { ctx, storage } = await setup()
    await storage.applyBatch({ put: { fxRates: [rate('r1', today, 'eur', 'uah', '49'), rate('r2', today, 'usd', 'eur', '0.85')] } })
    let called = 0
    const res = await refreshFxRates(ctx, today, [{ source: 'monobank', fetchPairs: async () => { called++; return mono } }])
    expect(res.status).toBe('fresh'); expect(called).toBe(0)
  })
  it('monobank недоступен: берёт ПриватБанк (USD через гривну)', async () => {
    const { ctx, storage } = await setup()
    const res = await refreshFxRates(ctx, today, [src('monobank', new Error('429')), src('privatbank', privat)])
    expect(res.status).toBe('updated'); expect(res.sources).toEqual(['privatbank']); expect(res.errors[0]).toContain('monobank')
    const rows = await storage.listFxRates()
    expect(rows).toHaveLength(2)
    expect(rows.every((r) => r.source === 'privatbank')).toBe(true)
  })
  it('оба банка недоступны: ничего не пишет, результат failed', async () => {
    const { ctx, storage } = await setup()
    const res = await refreshFxRates(ctx, today, [src('monobank', new Error('нет связи')), src('privatbank', new Error('нет связи'))])
    expect(res.status).toBe('failed'); expect(res.missing).toEqual(['uah', 'usd']); expect(res.errors).toHaveLength(2)
    expect(await storage.listFxRates()).toHaveLength(0)
  })
  it('частично: monobank даёт только UAH, USD добирается у ПриватБанка', async () => {
    const { ctx } = await setup()
    const res = await refreshFxRates(ctx, today, [src('monobank', [{ a: 'EUR', b: 'UAH', buy: 48, sell: 48.8 }]), src('privatbank', privat)])
    expect(res.status).toBe('updated'); expect(res.sources).toEqual(['monobank', 'privatbank'])
  })
  it('частично без второго источника: partial с перечнем недостающих', async () => {
    const { ctx } = await setup()
    const res = await refreshFxRates(ctx, today, [src('monobank', [{ a: 'EUR', b: 'UAH', buy: 48, sell: 48.8 }])])
    expect(res).toMatchObject({ status: 'partial', missing: ['usd'] })
  })
  it('повтор в тот же день: добирает только недостающее, дублей нет', async () => {
    const { ctx, storage } = await setup()
    await refreshFxRates(ctx, today, [src('monobank', [{ a: 'EUR', b: 'UAH', buy: 48, sell: 48.8 }])])   // только UAH
    const res = await refreshFxRates(ctx, today, [src('monobank', mono)])
    expect(res).toMatchObject({ status: 'updated', missing: [] })
    const rows = await storage.listFxRates()
    expect(rows).toHaveLength(2)
    expect(rows.filter((r) => r.quoteCurrencyKey === 'uah')).toHaveLength(1)
    expect((await refreshFxRates(ctx, today, [src('monobank', mono)])).status).toBe('fresh')
  })
  it('не владелец: пропуск без записи', async () => {
    const { ctx, storage } = await setup({ owner: false })
    const res = await refreshFxRates(ctx, today, [src('monobank', mono)])
    expect(res.status).toBe('skipped'); expect(await storage.listFxRates()).toHaveLength(0)
  })
  it('архивные счета и базовая валюта не требуют курса', async () => {
    const { ctx } = await setup()
    const fr = await fxFreshness(ctx, today)
    expect(fr.needed).toEqual(['uah', 'usd'])   // eur — база
  })
  it('срез после обновления считается в EUR по среднему курсу', async () => {
    const { ctx } = await setup()
    await createTransaction(ctx, { accountId: ID.cashUah, bookedAt: '2026-11-13T08:00:00Z', type: 'income', amountMinor: 484000 })   // 4840.00 UAH
    await refreshFxRates(ctx, today, [src('monobank', mono)])
    const snap = await getSnapshot(ctx, { date: today, accountIds: [ID.cashUah] })
    expect(snap.totals.complete).toBe(true)
    expect(snap.rows[0]!.balance.minor).toBe(10000)   // 4840 / 48.4 = 100.00 EUR
  })
})

describe('сообщения и пауза после неудачи', () => {
  const cur = new Map([['usd', usd], ['uah', uah]])
  it('тексты по статусам', () => {
    expect(describeFx({ status: 'fresh', sources: [], missing: [], errors: [] }, cur)).toBeNull()
    expect(describeFx({ status: 'updated', sources: ['monobank'], missing: [], errors: [] }, cur)).toEqual({ kind: 'ok', text: 'Курсы на сегодня обновлены (monobank).' })
    expect(describeFx({ status: 'partial', sources: ['monobank'], missing: ['usd'], errors: [] }, cur)!.text).toContain('USD')
    expect(describeFx({ status: 'failed', sources: [], missing: ['usd'], errors: ['monobank: нет связи'] }, cur)!.kind).toBe('warn')
  })
  it('автоповтор не чаще раза в 10 минут', () => {
    expect(shouldTry(1000, null)).toBe(true)
    expect(shouldTry(1000 + RETRY_AFTER_MS - 1, 1000)).toBe(false)
    expect(shouldTry(1000 + RETRY_AFTER_MS, 1000)).toBe(true)
  })
})
