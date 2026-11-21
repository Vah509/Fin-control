import { describe, expect, it } from 'vitest'
import { CoreError } from '../../src/core'
import { parseSkAmount, parseSlspStatement, reconcileAccount } from '../../src/core/statements'
import { buildSlsp, type FxOp, type FxStatement } from './slspFixture'

const card = (shop: string, dt: string, amount: string, balance: string, date = '04.09.2026', wrap = false): FxOp => ({
  dates: `${date} ${date}`,
  lines: ['Platba kartou', 'Č. k. 1111 22** **** 3333', ...(wrap ? [shop + ' ' + dt.slice(0, 7), dt.slice(8)] : [`${shop} ${dt}`]), 'Transakcia prostredníctvom GooglePay'],
  amount, balance,
})
const sepa = (iban: string, name: string, amount: string, balance: string, date = '05.09.2026'): FxOp => ({
  dates: `${date} ${date}`, lines: ['SEPA platba (elektronicky)', `${iban} BIC: TESTSKBX`, `Názov protiúčtu: ${name}`], amount, balance,
})

// Выдуманная выписка: 1000,00 + приход 500,00 - расходы 61,00 = 1439,00
const base = (): FxStatement => ({
  opening: '1 000,00', deposits: '500,00', withdrawals: '- 61,00', closing: '1 439,00',
  pages: [
    [
      card('Test Shop 1-Bratislava', '02. 09. 2026 17:10:34', '- 10,00', '990,00'),
      { dates: '04.09.2026 04.09.2026', lines: ['Prijatá SEPA platba', 'SK00 0000 0000 0000 0000 0002 BIC: TESTSKBX', 'Názov protiúčtu: Test Sender'], amount: '500,00', balance: '1 490,00' },
      card('Long Name Market 4020, BA, TEST-BRATISLAVA', '06. 09. 2026 11:55:51', '- 1,25', '1 488,75', '07.09.2026', true),
    ],
    [
      sepa('SK11 0000 0000 0000 0000 0003', 'Test Receiver', '- 40,00', '1 448,75'),
      card('Edge Cafe-BRATISLAVA', '28.09. 2026 07:15:23', '- 9,75', '1 439,00', '29.09.2026'),
    ],
  ],
})

describe('parseSkAmount', () => {
  it('знаки, пробелы, неразрывные пробелы', () => {
    expect(parseSkAmount('- 1 200,00')).toBe(-120000)
    expect(parseSkAmount('2\u00a0000,00')).toBe(200000)
    expect(parseSkAmount('1\u202f245,58')).toBe(124558)
    expect(parseSkAmount('−0,05')).toBe(-5)
  })
  it('не сумма: STATEMENT_PARSE', () => {
    expect(() => parseSkAmount('12.50')).toThrow(/STATEMENT_PARSE/)
  })
})

describe('parseSlspStatement', () => {
  const acc = () => parseSlspStatement(buildSlsp(base())).accounts[0]!

  it('шапка счёта', () => {
    const a = acc()
    expect(a.number).toBe('SK0000000000000000000001')
    expect(a.key).toBe('0001')
    expect(a.currency).toBe('EUR')
    expect(a.periodStart).toBe('2026-09-01')
    expect(a.periodEnd).toBe('2026-09-30')
    expect([a.openingMinor, a.depositsMinor, a.withdrawalsMinor, a.closingMinor]).toEqual([100000, 50000, 6100, 143900])
    expect(a.title).toBe('SPACE účet')
    expect(a.rows).toHaveLength(5)
  })

  it('карта: торговая точка без даты, время, маска, описание', () => {
    const r = acc().rows[0]!
    expect(r.counterparty).toEqual({ kind: 'card', name: 'Test Shop 1-Bratislava', iban: null })
    expect(r.time).toBe('17:10:34')
    expect(r.cardMask).toBe('1111 22** **** 3333')
    expect(r.amountMinor).toBe(-1000)
    expect(r.balanceAfterMinor).toBe(99000)
    expect(r.bookingDate).toBe('2026-09-04')
    expect(r.description).toBe('Platba kartou Č. k. 1111 22** **** 3333 Test Shop 1-Bratislava 02. 09. 2026 17:10:34 Transakcia prostredníctvom GooglePay')
  })

  it('SEPA: IBAN без пробелов и имя; времени нет', () => {
    const r = acc().rows[1]!
    expect(r.counterparty).toEqual({ kind: 'sepa', name: 'Test Sender', iban: 'SK0000000000000000000002' })
    expect(r.time).toBeNull()
    expect(r.amountMinor).toBe(50000)
  })

  it('перенос строки описания: торговая точка и время склеиваются', () => {
    const r = acc().rows[2]!
    expect(r.counterparty.name).toBe('Long Name Market 4020, BA, TEST-BRATISLAVA')
    expect(r.time).toBe('11:55:51')
  })

  it('дата с форматом 28.09. 2026', () => {
    const r = acc().rows[4]!
    expect(r.counterparty.name).toBe('Edge Cafe-BRATISLAVA')
    expect(r.time).toBe('07:15:23')
  })

  it('несколько страниц с повторной шапкой: сквозная нумерация', () => {
    expect(acc().rows.map((r) => r.n)).toEqual([1, 2, 3, 4, 5])
    expect(acc().rows[3]!.counterparty.name).toBe('Test Receiver')
  })

  it('неразрывные пробелы в суммах и остатках', () => {
    const st = base()
    st.pages[0]![1]!.balance = '1\u00a0490,00'
    st.pages[0]![1]!.amount = '500,00'
    st.opening = '1\u00a0000,00'
    const a = parseSlspStatement(buildSlsp(st)).accounts[0]!
    expect(a.rows[1]!.balanceAfterMinor).toBe(149000)
    expect(a.openingMinor).toBe(100000)
  })

  it('комиссия: колонка «Suma poplatku» входит в цепочку', () => {
    const st = base()
    st.pages = [[{ ...card('Fee Shop', '02. 09. 2026 10:00:00', '- 10,00', '989,00'), fee: '- 1,00' }]]
    st.deposits = '0,00'; st.withdrawals = '- 11,00'; st.closing = '989,00'
    const a = parseSlspStatement(buildSlsp(st)).accounts[0]!
    expect(a.rows[0]!.feeMinor).toBe(-100)
    expect(reconcileAccount(a).ok).toBe(true)
  })

  it('не выписка: STATEMENT_UNRECOGNIZED', () => {
    expect(() => parseSlspStatement([{ items: [{ str: 'Hello', x: 10, y: 10, w: 20 }] }])).toThrow(/STATEMENT_UNRECOGNIZED/)
    expect(() => parseSlspStatement([])).toThrow(CoreError)
  })

  it('другой номер счёта на странице 2: STATEMENT_PARSE', () => {
    const pages = buildSlsp(base())
    const hit = pages[1]!.items.find((i) => i.str.startsWith('SK00'))!
    hit.str = 'SK99 0000 0000 0000 0000 0009'
    expect(() => parseSlspStatement(pages)).toThrow(/STATEMENT_PARSE/)
  })
})

describe('reconcileAccount', () => {
  it('сходится: цепочка, итоги, остаток', () => {
    const r = reconcileAccount(parseSlspStatement(buildSlsp(base())).accounts[0]!)
    expect(r).toMatchObject({ ok: true, rowCount: 5, badRows: [], firstBadRow: null, closingComputedMinor: 143900, depositsComputedMinor: 50000, withdrawalsComputedMinor: 6100 })
  })

  it('ошибка в остатке строки: указан номер, остальные строки не краснеют', () => {
    const st = base()
    st.pages[1]![0]!.balance = '1 448,00' // верно 1 448,75
    const r = reconcileAccount(parseSlspStatement(buildSlsp(st)).accounts[0]!)
    expect(r.ok).toBe(false)
    expect(r.badRows).toEqual([4, 5])
    expect(r.firstBadRow).toBe(4)
  })

  it('расхождение итогов шапки при верной цепочке', () => {
    const st = base()
    st.withdrawals = '- 62,00'
    const r = reconcileAccount(parseSlspStatement(buildSlsp(st)).accounts[0]!)
    expect(r.ok).toBe(false)
    expect(r.badRows).toEqual([])
    expect(r.withdrawalsExpectedMinor).toBe(6200)
    expect(r.withdrawalsComputedMinor).toBe(6100)
  })

  it('конечный остаток не совпал', () => {
    const st = base()
    st.closing = '1 440,00'
    const r = reconcileAccount(parseSlspStatement(buildSlsp(st)).accounts[0]!)
    expect(r.ok).toBe(false)
    expect(r.closingExpectedMinor).toBe(144000)
    expect(r.closingComputedMinor).toBe(143900)
  })
})
