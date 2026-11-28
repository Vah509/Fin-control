import { describe, expect, it } from 'vitest'
import ExcelJS from 'exceljs'
import { CoreError } from '../../src/core'
import { parsePrivatStatement, reconcileAccount } from '../../src/core/statements'

const HEAD = ['Дата', 'Категорія', 'Картка', 'Опис операції', 'Сума в валюті картки', 'Валюта картки', 'Сума в валюті транзакції', 'Валюта транзакції', 'Залишок на кінець періоду', 'Валюта залишку']
// Выдуманные данные в раскладке Привата: новые сверху, две карты вперемешку
const ROWS: unknown[][] = [
  ['27.11.2026 19:51:10', 'Супермаркети та продукти', '1111 **** **** 0001', 'TESTMARKET', -800.5, 'UAH', 16.01, 'EUR', 1200.0, 'UAH'],
  ['26.11.2026 10:00:00', 'Перекази', '2222 **** **** 0002', 'Тестов Т.', -100, 'UAH', 100, 'UAH', 50.5, 'UAH'],
  ['25.11.2026 20:13:59', 'Зарахування переказу', '1111 **** **** 0001', 'Іванов І.', 2000.5, 'UAH', 2000.5, 'UAH', 2000.5, 'UAH'],
  ['25.11.2026 20:13:59', 'Ресторани, кафе, бари', '2222 **** **** 0002', 'CAFE TEST', -49.5, 'UAH', -49.5, 'UAH', 150.5, 'UAH'],
]
async function book(rows = ROWS, head = HEAD): Promise<Uint8Array> {
  const wb = new ExcelJS.Workbook(); const ws = wb.addWorksheet('Виписки')
  ws.addRow(['Історія операцій за період 25.11.2026 - 28.11.2026']); ws.addRow(head); rows.forEach((r) => ws.addRow(r))
  return new Uint8Array((await wb.xlsx.writeBuffer()) as ArrayBuffer)
}

describe('Приват XLSX', () => {
  it('делит по картам, разворачивает хронологию, считает остатки и сверяется', async () => {
    const st = await parsePrivatStatement(await book())
    expect(st.bank).toBe('privat')
    expect(st.accounts.map((a) => a.key)).toEqual(['0001', '0002'])
    const a = st.accounts[0]!
    expect(a.rows.map((r) => r.amountMinor)).toEqual([200050, -80050])
    expect(a.rows[0]!.time).toBe('20:13:59'); expect(a.periodStart).toBe('2026-11-25'); expect(a.periodEnd).toBe('2026-11-28')
    expect(a.openingMinor).toBe(0); expect(a.closingMinor).toBe(120000)
    expect(a.rows[1]!.description).toBe('TESTMARKET (16.01 EUR)'); expect(a.rows[1]!.category).toBe('Супермаркети та продукти')
    expect(a.rows[0]!.counterparty.kind).toBe('other'); expect(a.rows[1]!.counterparty.kind).toBe('card')
    const b = st.accounts[1]!
    expect(b.rows.map((r) => r.n)).toEqual([1, 2]); expect(b.openingMinor).toBe(20000)
    for (const x of st.accounts) expect(reconcileAccount(x).ok).toBe(true)
  })
  it('цепочка остатков не сходится: сверка красная', async () => {
    const bad = ROWS.map((r) => [...r]); bad[0]![8] = 1300
    const st = await parsePrivatStatement(await book(bad))
    expect(reconcileAccount(st.accounts[0]!).ok).toBe(false)
  })
  it('чужой файл: STATEMENT_UNRECOGNIZED', async () => {
    await expect(parsePrivatStatement(await book(ROWS, ['a', 'b']))).rejects.toMatchObject({ code: 'STATEMENT_UNRECOGNIZED' })
    await expect(parsePrivatStatement(new Uint8Array([1, 2, 3]))).rejects.toBeInstanceOf(CoreError)
  })
})
