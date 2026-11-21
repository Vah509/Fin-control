import { describe, expect, it } from 'vitest'
import { applyCounterpartyFile, buildOperationsWorkbook, compareWithDb, operationsFileName, parseSlspStatement, OPS_SHEET, RECON_SHEET } from '../../src/core/statements'
import type { Transaction } from '../../src/data/types'
import { ID, setup } from '../helpers'
import { buildSlsp } from './slspFixture'

const stmt = () => parseSlspStatement(buildSlsp({
  opening: '1 000,00', deposits: '500,00', withdrawals: '- 20,00', closing: '1 480,00',
  pages: [[
    { dates: '04.09.2026 04.09.2026', lines: ['Platba kartou', 'Č. k. 1111 22** **** 3333', 'Lidl dakuje 165-BRATISLAVA 02. 09. 2026 17:10:34', 'Transakcia prostredníctvom GooglePay'], amount: '- 10,00', balance: '990,00' },
    { dates: '05.09.2026 05.09.2026', lines: ['Platba kartou', 'Č. k. 1111 22** **** 3333', 'Lidl dakuje 185-BRATISLAVA 03. 09. 2026 10:10:10', 'Transakcia prostredníctvom GooglePay'], amount: '- 10,00', balance: '980,00' },
    { dates: '06.09.2026 06.09.2026', lines: ['Prijatá SEPA platba', 'SK00 0000 0000 0000 0000 0002 BIC: TESTSKBX', 'Názov protiúčtu: Test Sender'], amount: '500,00', balance: '1 480,00' },
  ]],
}))

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function load(bytes: Uint8Array): Promise<any> {
  const m: any = await import('exceljs')
  const wb = new (m.default ?? m).Workbook()
  await wb.xlsx.load(bytes.slice())
  return wb
}
const tx = (id: string, date: string, amountMinor: number, over: Partial<Transaction> = {}): Transaction => ({
  id, accountId: ID.space, counterpartyId: null, importId: null, source: 'manual', bookedAt: `${date}T10:00:00.000Z`, type: amountMinor > 0 ? 'income' : 'expense',
  amountMinor, currencyKey: 'eur', originalAmountMinor: null, originalCurrencyKey: null, tagId: null, planType: null, comment: null,
  transferId: null, dedupeHash: null, deletedAt: null, isOpening: false, raw: null, createdBy: null, createdAt: '2026-11-01T00:00:00.000Z', updatedAt: '2026-11-01T00:00:00.000Z', ...over,
})
async function withDb(txs: Transaction[]) {
  const t = await setup({ withCrypto: true })
  const key = stmt().accounts[0]!.key
  await t.storage.applyBatch({ put: {
    accountIdentifiers: [{ id: 'i1', accountId: ID.space, kind: 'account_number', valueHash: 'h', valueEnc: 'e', last4: key, validFrom: '2020-01-01', validTo: null }],
    transactions: txs,
  } })
  return t
}

describe('файл «Операции + Сверка»', () => {
  it('листы, колонки без времени, числа, контрагенты из справочника, сверка ОК', async () => {
    const { ctx } = await setup({ withCrypto: true })
    await applyCounterpartyFile(ctx, [
      { row: 2, text: 'Lidl dakuje 165-BRATISLAVA', resolved: '', newName: 'Lidl', iban: null },
      { row: 3, text: 'Lidl dakuje 185-BRATISLAVA', resolved: '', newName: 'Lidl', iban: null },
    ])
    const wb = await load(await buildOperationsWorkbook(ctx, stmt()))
    const ws = wb.getWorksheet(OPS_SHEET)
    expect(ws.getRow(1).values.slice(1)).toEqual(['№', 'Дата', 'Счёт', 'Контрагент', 'Сумма', 'Валюта', 'Остаток после', 'Описание из выписки', 'В выписке', 'В базе'])
    expect(ws.rowCount).toBe(4)
    const r1 = ws.getRow(2)
    expect([r1.getCell(1).value, r1.getCell(4).value, r1.getCell(5).value, r1.getCell(6).value, r1.getCell(7).value, r1.getCell(9).value, r1.getCell(10).value]).toEqual([1, 'Lidl', -10, 'EUR', 990, '+', ''])
    expect(ws.getRow(3).getCell(4).value).toBe('Lidl')
    expect(ws.getRow(4).getCell(4).value).toBe('Test Sender') // не опознан: текст из выписки
    expect(String(r1.getCell(8).value)).toContain('Lidl dakuje 165')
    expect(wb.getWorksheet(RECON_SHEET).getRow(2).getCell(14).value).toBe('ОК')
    expect(ws.getRow(2).getCell(1).fill?.fgColor?.argb).toBeUndefined()
  })

  it('комиссия отдельной строкой-расходом после своей операции', async () => {
    const { ctx } = await setup({ withCrypto: true })
    const st = stmt()
    const a = st.accounts[0]!
    a.rows[0]!.feeMinor = -50
    for (const r of a.rows) r.balanceAfterMinor -= 50
    a.closingMinor -= 50; a.withdrawalsMinor += 50
    const ws = (await load(await buildOperationsWorkbook(ctx, st))).getWorksheet(OPS_SHEET)
    expect(ws.rowCount).toBe(5)
    expect([ws.getRow(2).getCell(5).value, ws.getRow(2).getCell(7).value]).toEqual([-10, 990])
    expect([ws.getRow(3).getCell(1).value, ws.getRow(3).getCell(4).value, ws.getRow(3).getCell(5).value, ws.getRow(3).getCell(7).value]).toEqual([1, 'Комиссия банка', -0.5, 989.5])
    expect(ws.getRow(4).getCell(1).value).toBe(2)
  })

  it('расхождение: строка красным, «НЕ СОШЛОСЬ» с номером строки', async () => {
    const { ctx } = await setup({ withCrypto: true })
    const st = stmt()
    st.accounts[0]!.rows[1]!.balanceAfterMinor += 1
    const wb = await load(await buildOperationsWorkbook(ctx, st))
    const ws = wb.getWorksheet(OPS_SHEET)
    expect(ws.getRow(3).getCell(1).fill.fgColor.argb).toBe('FFFFC7CE')
    expect(ws.getRow(2).getCell(1).fill?.fgColor?.argb).toBeUndefined()
    expect(String(wb.getWorksheet(RECON_SHEET).getRow(2).getCell(14).value)).toContain('НЕ СОШЛОСЬ: первая строка 2')
  })

  it('имя файла: банк и месяц конца периода', () => {
    expect(operationsFileName(stmt())).toMatch(/^slsp_2026-09\.xlsx$/)
  })
})

describe('сравнение выписки с базой', () => {
  it('счёта нет в базе: сравнения нет, «В базе» пусто', async () => {
    const { ctx } = await setup({ withCrypto: true })
    const c = await compareWithDb(ctx, stmt())
    expect(c.missingAccounts).toEqual([stmt().accounts[0]!.key])
    expect(c.dbOnly).toEqual([])
    expect(Object.values(c.inDb)).toEqual([])
  })

  it('новая выписка: в базе пусто, проблем нет', async () => {
    const { ctx } = await withDb([])
    const c = await compareWithDb(ctx, stmt())
    expect(c.missingAccounts).toEqual([])
    expect(c.dbOnly).toEqual([])
    expect(Object.values(c.inDb).every((v) => !v)).toBe(true)
  })

  it('повторная загрузка: одинаковые строки как набор с количеством, порядок не важен', async () => {
    const { ctx } = await withDb([tx('t3', '2026-09-06', 50000), tx('t2', '2026-09-05', -1000), tx('t1', '2026-09-04', -1000)])
    const c = await compareWithDb(ctx, stmt())
    expect(Object.values(c.inDb)).toEqual([true, true, true])
    expect(c.dbOnly).toEqual([])
  })

  it('часть строк выписки в базе, лишняя запись в базе это проблема; корректировки, удалённые и чужой период не считаются', async () => {
    const { ctx } = await withDb([
      tx('a', '2026-09-04', -1000), tx('c', '2026-09-05', -1000), // две из трёх строк выписки
      tx('x', '2026-09-05', -777, { comment: 'лишняя' }),                                         // нет в выписке
      tx('adj', '2026-09-05', -1, { type: 'adjustment' }), tx('op', '2026-09-04', 5, { isOpening: true, type: 'adjustment' }), // корректировки не считаются
      tx('del', '2026-09-05', -1000, { deletedAt: '2026-10-01T00:00:00.000Z' }),                   // удалённая не считается
      tx('out', '2026-08-01', -5),                                                                 // вне периода
    ])
    const c = await compareWithDb(ctx, stmt())
    const key = stmt().accounts[0]!.key
    expect(c.inDb[`${key}:1:operation`]).toBe(true)
    expect(c.inDb[`${key}:2:operation`]).toBe(true)
    expect(c.inDb[`${key}:3:operation`]).toBe(false)
    expect(c.dbOnly).toHaveLength(1)
    expect(c.dbOnly[0]).toMatchObject({ transactionId: 'x', date: '2026-09-05', amountMinor: -777, comment: 'лишняя' })
  })

  it('файл: «В базе» и жёлтая строка «только в базе» в конце', async () => {
    const { ctx } = await withDb([tx('t1', '2026-09-04', -1000), tx('x', '2026-09-05', -777)])
    const st = stmt()
    const ws = (await load(await buildOperationsWorkbook(ctx, st, await compareWithDb(ctx, st)))).getWorksheet(OPS_SHEET)
    expect(ws.rowCount).toBe(5)
    expect([ws.getRow(2).getCell(10).value, ws.getRow(3).getCell(10).value]).toEqual(['+', ''])
    const last = ws.getRow(5)
    expect([last.getCell(1).value, last.getCell(5).value, last.getCell(9).value, last.getCell(10).value]).toEqual(['', -7.77, '', '+'])
    expect(last.getCell(1).fill.fgColor.argb).toBe('FFFFF2CC')
  })

  it('одинаковые строки: в выписке 3, в базе 2 и ещё одна лишняя того же вида: ровно одна проблема', async () => {
    const same = (id: string) => tx(id, '2026-09-04', -1000)
    const { ctx } = await withDb([same('a'), same('b')])
    const st = stmt()
    st.accounts[0]!.rows[1]!.bookingDate = '2026-09-04'          // теперь в выписке две одинаковые (09-04, −10,00)
    const c = await compareWithDb(ctx, st)
    const key = st.accounts[0]!.key
    expect([c.inDb[`${key}:1:operation`], c.inDb[`${key}:2:operation`]]).toEqual([true, true])
    expect(c.dbOnly).toEqual([])
    await ctx.storage.applyBatch({ put: { transactions: [same('c')] } })
    expect((await compareWithDb(ctx, st)).dbOnly).toHaveLength(1)
  })
})
