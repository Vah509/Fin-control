import { describe, expect, it } from 'vitest'
import { applyCounterpartyFile, buildOperationsWorkbook, operationsFileName, parseSlspStatement, OPS_SHEET, RECON_SHEET } from '../../src/core/statements'
import { setup } from '../helpers'
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

describe('файл «Операции + Сверка»', () => {
  it('листы, колонки, числа, контрагенты из справочника, сверка ОК', async () => {
    const { ctx } = await setup({ withCrypto: true })
    await applyCounterpartyFile(ctx, [
      { row: 2, text: 'Lidl dakuje 165-BRATISLAVA', resolved: '', newName: 'Lidl', iban: null },
      { row: 3, text: 'Lidl dakuje 185-BRATISLAVA', resolved: '', newName: 'Lidl', iban: null },
    ])
    const wb = await load(await buildOperationsWorkbook(ctx, stmt()))
    const ws = wb.getWorksheet(OPS_SHEET)
    expect(ws.getRow(1).values.slice(1, 10)).toEqual(['№', 'Дата', 'Время', 'Счёт', 'Контрагент', 'Сумма', 'Валюта', 'Остаток после', 'Описание из выписки'])
    expect(ws.rowCount).toBe(4)
    const r1 = ws.getRow(2)
    expect([r1.getCell(1).value, r1.getCell(3).value, r1.getCell(5).value, r1.getCell(6).value, r1.getCell(7).value, r1.getCell(8).value]).toEqual([1, '17:10:34', 'Lidl', -10, 'EUR', 990])
    expect(ws.getRow(3).getCell(5).value).toBe('Lidl')
    expect(ws.getRow(4).getCell(5).value).toBe('Test Sender') // не опознан: текст из выписки
    expect(ws.getRow(4).getCell(3).value).toBe('')         // у SEPA времени нет
    expect(String(r1.getCell(9).value)).toContain('Lidl dakuje 165')
    const rc = wb.getWorksheet(RECON_SHEET)
    expect(rc.getRow(2).getCell(14).value).toBe('ОК')
    expect(ws.getRow(2).getCell(1).fill?.fgColor?.argb).toBeUndefined()
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
