// Разбор XLSX ПриватБанка («Історія операцій за період…»). Подробно: docs/STATEMENT-XLSX.md, раздел 25.
// В файле несколько карт вперемешку (новые сверху), у каждой строки остаток по её карте. Итогов периода нет:
// сверка только цепочкой остатков внутри карты; начальный остаток = остаток первой строки минус её сумма.
import { fail } from '../errors'
import { parseMinor } from '../money'
import type { ParsedStatement, StatementAccount, StatementRow } from './types'

const HEAD = ['Дата', 'Категорія', 'Картка', 'Опис операції', 'Сума в валюті картки', 'Валюта картки', 'Сума в валюті транзакції', 'Валюта транзакції', 'Залишок на кінець періоду', 'Валюта залишку'] as const
type Col = (typeof HEAD)[number]
const TRANSFER_CATEGORIES = new Set(['перекази', 'зарахування переказу'])

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const loadExcel = async (): Promise<any> => {
  try { const m: any = await import('exceljs'); return m.default ?? m } catch {
    throw new Error('Не удалось загрузить модуль Excel. Закройте приложение полностью и откройте снова (возможно, вышла новая версия)')
  }
}

const txt = (v: unknown): string => (v == null ? '' : typeof v === 'object' && 'text' in (v as object) ? String((v as { text: unknown }).text) : String(v)).replace(/[\s\u00a0\u202f]+/g, ' ').trim()

function minor(v: unknown, what: string): number {
  if (typeof v === 'number') return parseMinor(v.toFixed(2), 2)
  const t = txt(v).replace(/ /g, '').replace(',', '.').replace(/[−–]/g, '-')
  if (!/^-?\d+(\.\d{1,2})?$/.test(t)) return fail('STATEMENT_PARSE', `${what}: не сумма «${txt(v)}»`)
  return parseMinor(t, 2)
}

/** 'дд.мм.гггг чч:мм:сс' (или Date) -> дата ISO и время. */
function dateTime(v: unknown, rowNo: number): { date: string; time: string } {
  if (v instanceof Date) { const s = v.toISOString(); return { date: s.slice(0, 10), time: s.slice(11, 19) } }
  const m = /^(\d{1,2})\.(\d{1,2})\.(\d{4})(?: (\d{1,2}):(\d{2})(?::(\d{2}))?)?$/.exec(txt(v))
  if (!m) return fail('STATEMENT_PARSE', `строка ${rowNo}: не дата «${txt(v)}»`)
  return { date: `${m[3]}-${m[2]!.padStart(2, '0')}-${m[1]!.padStart(2, '0')}`, time: `${(m[4] ?? '0').padStart(2, '0')}:${m[5] ?? '00'}:${m[6] ?? '00'}` }
}

export async function parsePrivatStatement(bytes: Uint8Array): Promise<ParsedStatement> {
  const ExcelJS = await loadExcel()
  const wb = new ExcelJS.Workbook()
  try { await wb.xlsx.load(bytes) } catch { fail('STATEMENT_UNRECOGNIZED', 'не удалось открыть файл как XLSX') }
  const ws = wb.worksheets[0]
  if (!ws) return fail('STATEMENT_UNRECOGNIZED', 'в файле нет листов')

  // шапка: строка с названиями колонок (первые 5 строк)
  let headRow = 0
  const idx = {} as Record<Col, number>
  for (let r = 1; r <= Math.min(5, ws.rowCount) && !headRow; r++) {
    const names = new Map<string, number>()
    ws.getRow(r).eachCell({ includeEmpty: false }, (c: { value: unknown }, n: number) => names.set(txt(c.value), n))
    if (HEAD.every((h) => names.has(h))) { headRow = r; for (const h of HEAD) idx[h] = names.get(h)! }
  }
  if (!headRow) return fail('STATEMENT_UNRECOGNIZED', 'не выписка ПриватБанка (нет колонок «Дата», «Картка», «Залишок на кінець періоду»…)')

  const period = /(\d{2})\.(\d{2})\.(\d{4})\s*-\s*(\d{2})\.(\d{2})\.(\d{4})/.exec(txt(ws.getRow(1).getCell(1).value))
  type Raw = { rowNo: number; date: string; time: string; category: string; mask: string; key: string; desc: string; amount: number; cur: string; txAmount: number; txCur: string; balance: number }
  const raws: Raw[] = []
  for (let r = headRow + 1; r <= ws.rowCount; r++) {
    const row = ws.getRow(r)
    const cell = (h: Col) => row.getCell(idx[h]).value
    if (txt(cell('Дата')) === '' && txt(cell('Картка')) === '') continue
    const mask = txt(cell('Картка'))
    const key = /(\d{4})$/.exec(mask)?.[1] ?? fail('STATEMENT_PARSE', `строка ${r}: нет карты «${mask}»`)
    const cur = txt(cell('Валюта картки')).toUpperCase()
    if (txt(cell('Валюта залишку')).toUpperCase() !== cur) fail('STATEMENT_PARSE', `строка ${r}: валюта остатка не равна валюте карты`)
    const { date, time } = dateTime(cell('Дата'), r)
    raws.push({
      rowNo: r, date, time, category: txt(cell('Категорія')), mask, key, desc: txt(cell('Опис операції')), cur,
      amount: minor(cell('Сума в валюті картки'), `строка ${r}`), txAmount: minor(cell('Сума в валюті транзакції'), `строка ${r}`),
      txCur: txt(cell('Валюта транзакції')).toUpperCase(), balance: minor(cell('Залишок на кінець періоду'), `строка ${r}`),
    })
  }
  if (!raws.length) return fail('STATEMENT_PARSE', 'в выписке нет операций')

  // В файле новые сверху: разворачиваем в хронологию. Порядок внутри одной секунды сохраняется (обратный файловому).
  const chrono = [...raws].reverse().sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time))
  const byCard = new Map<string, Raw[]>()
  for (const x of chrono) byCard.set(x.key, [...(byCard.get(x.key) ?? []), x])

  const accounts: StatementAccount[] = []
  for (const [key, list] of [...byCard].sort((a, b) => a[0].localeCompare(b[0]))) {
    const rows: StatementRow[] = list.map((x, i) => {
      const foreign = x.txCur !== x.cur
      const fmt = (m: number) => (Math.abs(m) / 100).toFixed(2)
      const transfer = TRANSFER_CATEGORIES.has(x.category.toLowerCase())
      return {
        n: i + 1, accountKey: key, valueDate: x.date, bookingDate: x.date, time: x.time, title: x.category,
        counterparty: { kind: transfer ? 'other' : 'card', name: x.desc, iban: null },
        cardMask: x.mask, category: x.category,
        description: foreign ? `${x.desc} (${fmt(x.txAmount)} ${x.txCur})` : x.desc,
        amountMinor: x.amount, feeMinor: 0, balanceAfterMinor: x.balance, currency: x.cur,
      }
    })
    let dep = 0, wd = 0
    for (const r of rows) { if (r.amountMinor > 0) dep += r.amountMinor; else wd -= r.amountMinor }
    const first = rows[0]!, last = rows[rows.length - 1]!
    accounts.push({
      number: list[0]!.mask, key, title: `Приват •••• ${key}`, holderName: '', currency: first.currency,
      periodStart: period ? `${period[3]}-${period[2]}-${period[1]}` : first.bookingDate,
      periodEnd: period ? `${period[6]}-${period[5]}-${period[4]}` : last.bookingDate,
      openingMinor: first.balanceAfterMinor - first.amountMinor, closingMinor: last.balanceAfterMinor,
      depositsMinor: dep, withdrawalsMinor: wd, rows,
    })
  }
  return { bank: 'privat', accounts }
}
