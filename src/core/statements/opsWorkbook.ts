// Файл «Операции + Сверка» (шаг 3 работы с выпиской): стандартный XLSX, листы «Операции» и «Сверка». В базу ничего не пишет.
import type { CoreContext } from '../context'
import { collectCounterpartyGroups, groupKeyOf, recognizeGroups } from './counterparties'
import { reconcileAccount } from './reconcile'
import type { ParsedStatement } from './types'

export const OPS_SHEET = 'Операции'
export const RECON_SHEET = 'Сверка'
export const OPS_HEADERS = ['№', 'Дата', 'Время', 'Счёт', 'Контрагент', 'Сумма', 'Валюта', 'Остаток после', 'Описание из выписки', 'Комиссия']
export const RECON_HEADERS = ['Счёт', 'Название', 'Валюта', 'Период с', 'Период по', 'Начальный остаток', 'Вклады (выписка)', 'Вклады (расчёт)', 'Выборы (выписка)', 'Выборы (расчёт)', 'Конечный остаток (выписка)', 'Конечный остаток (расчёт)', 'Строк', 'Результат']
const RED = 'FFFFC7CE'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const loadExcel = async (): Promise<any> => {
  try { const m: any = await import('exceljs'); return m.default ?? m } catch {
    throw new Error('Не удалось загрузить модуль Excel. Закройте приложение полностью и откройте снова (возможно, вышла новая версия)')
  }
}
const money = (minor: number) => minor / 100
const isoDate = (s: string) => new Date(`${s}T00:00:00Z`)

/** Имя файла: <банк>_<ГГГГ-ММ>.xlsx (месяц конца периода первого счёта). */
export function operationsFileName(st: ParsedStatement): string {
  return `${st.bank}_${(st.accounts[0]?.periodEnd ?? '').slice(0, 7)}.xlsx`
}

/** Сборка XLSX. Контрагент: опознанный по справочнику, иначе текст из выписки. Расхождение сверки: строки красным, результат «НЕ СОШЛОСЬ». */
export async function buildOperationsWorkbook(ctx: CoreContext, st: ParsedStatement): Promise<Uint8Array> {
  const ExcelJS = await loadExcel()
  const groups = collectCounterpartyGroups(st)
  const found = await recognizeGroups(ctx, groups)
  const nameByKey = new Map<string, string>()
  groups.forEach((g, i) => {
    const key = groupKeyOf({ name: g.text, iban: g.iban })
    nameByKey.set(key, found[i]?.name ?? g.text)
  })

  const wb = new ExcelJS.Workbook()
  const ws = wb.addWorksheet(OPS_SHEET)
  ws.columns = OPS_HEADERS.map((header, i) => ({ header, width: [6, 12, 10, 8, 32, 14, 9, 16, 70, 12][i] }))
  const rs = wb.addWorksheet(RECON_SHEET)
  rs.columns = RECON_HEADERS.map((header, i) => ({ header, width: i === 1 ? 28 : i === 13 ? 34 : 16 }))

  for (const acc of st.accounts) {
    const rec = reconcileAccount(acc)
    const bad = new Set(rec.badRows)
    for (const r of acc.rows) {
      const cp = nameByKey.get(groupKeyOf(r.counterparty)) ?? r.counterparty.name
      const row = ws.addRow([r.n, isoDate(r.bookingDate), r.time ?? '', r.accountKey, cp, money(r.amountMinor), r.currency, money(r.balanceAfterMinor), r.description, money(r.feeMinor)])
      row.getCell(2).numFmt = 'DD.MM.YYYY'
      for (const c of [6, 8, 10]) row.getCell(c).numFmt = '#,##0.00'
      if (bad.has(r.n)) row.eachCell({ includeEmpty: true }, (cell: { fill: unknown }) => { cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: RED } } })
    }
    const result = rec.ok ? 'ОК' : `НЕ СОШЛОСЬ${rec.firstBadRow ? `: первая строка ${rec.firstBadRow}` : ''}${rec.badRows.length ? `, строк с расхождением ${rec.badRows.length}` : ''}`
    const rr = rs.addRow([acc.key, acc.title, acc.currency, isoDate(acc.periodStart), isoDate(acc.periodEnd), money(rec.openingMinor),
      money(rec.depositsExpectedMinor), money(rec.depositsComputedMinor), money(rec.withdrawalsExpectedMinor), money(rec.withdrawalsComputedMinor),
      money(rec.closingExpectedMinor), money(rec.closingComputedMinor), rec.rowCount, result])
    for (const c of [4, 5]) rr.getCell(c).numFmt = 'DD.MM.YYYY'
    for (let c = 6; c <= 12; c++) rr.getCell(c).numFmt = '#,##0.00'
    if (!rec.ok) rr.eachCell({ includeEmpty: true }, (cell: { fill: unknown }) => { cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: RED } } })
  }
  for (const w of [ws, rs]) { w.getRow(1).font = { bold: true }; w.views = [{ state: 'frozen', ySplit: 1 }] }
  return new Uint8Array((await wb.xlsx.writeBuffer()) as ArrayBuffer)
}
