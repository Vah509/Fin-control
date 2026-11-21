// Фикстура: выдуманные слова с координатами в раскладке выписки Slovenská sporiteľňa (как у pdfjs).
import type { PdfPage, PdfTextItem } from '../../src/core/statements'

export interface FxOp { dates: string; lines: string[]; amount?: string; fee?: string; balance: string }
export interface FxStatement {
  number?: string; opening: string; deposits: string; withdrawals: string; closing: string
  pages: FxOp[][]
}

const w = (s: string) => s.length * 4.6
const item = (str: string, x: number, y: number, width = w(str)): PdfTextItem => ({ str, x, y, w: width })
const HEADER = (y: number): PdfTextItem[] => [
  item('Dátum', 34, y), item(' ', 62, y), item('Dátum', 86.5, y), item('Popis', 143.1, y), item('Suma', 384.1, y), item('Suma', 435.1, y), item('Zostatok', 503.1, y),
  item('valuty', 34, y - 11), item('zúčtovania', 86.5, y - 11), item('transakcie', 143.1, y - 11), item('transakcie', 384.1, y - 11), item('poplatku', 435.1, y - 11), item('po transakcii', 503.1, y - 11),
]

function tableOps(ops: FxOp[], y0: number): PdfTextItem[] {
  const out: PdfTextItem[] = []
  let y = y0
  for (const op of ops) {
    out.push(item('', 34, y, 0), item(op.dates, 34, y, 102), item(' ', 136, y, 7), item(op.lines[0]!, 143.1, y))
    op.lines.slice(1).forEach((l, i) => out.push(item(l, 143.1, y - 11 * (i + 1))))
    if (op.amount) out.push(item(op.amount, 429.4 - w(op.amount), y, w(op.amount)))
    if (op.fee) out.push(item(op.fee, 503 - w(op.fee), y, w(op.fee)))
    out.push(item(op.balance, 561.3 - w(op.balance), y, w(op.balance)))
    y -= 11 * op.lines.length + 0.1 + 11
  }
  return out
}

export function buildSlsp(st: FxStatement): PdfPage[] {
  const number = st.number ?? 'SK00 0000 0000 0000 0000 0001'
  return st.pages.map((ops, p) => {
    const items: PdfTextItem[] = []
    let top: number
    if (p === 0) {
      items.push(
        item('Test Holder', 320.3, 763.2), item('Test street 1', 320.3, 751.2),
        item('Slovenská sporiteľňa, a.s.', 35.4, 751.5),
        item('Výpis z Účtu:', 35.4, 695.1), item('SPACE účet', 126.5, 695.1),
        item('Názov Účtu', 44.4, 671.2), item('Test Holder', 178.1, 671.2), item('Účtovné obdobie', 323.6, 671.2), item('01. 09. 2026 - 30. 09. 2026', 433.3, 671.2),
        item('Číslo Účtu', 44.4, 654.1), item(number, 124.3, 654.1), item('Počiatočný stav Účtu', 323.6, 654.1), item(st.opening, 514.9, 654.1),
        item('BIC', 44.4, 637.1), item('GIBASKBX', 226.9, 637.1), item('Vklady spolu', 323.6, 637.1), item(st.deposits, 511.8, 637.1),
        item('Mena', 44.4, 620.1), item('EUR', 253.4, 620.1), item('Výbery spolu', 323.6, 620.1), item(st.withdrawals, 507.1, 620.1),
        item('Dátum vyhotovenia výpisu', 44.4, 603.1), item('30. 09. 2026', 216.4, 603.1), item('Konečný stav Účtu', 323.6, 603.1), item(st.closing, 513.5, 603.1),
      )
      items.push(...HEADER(575.2)); top = 538.4
    } else {
      items.push(
        item('Číslo Účtu', 44.4, 777.7), item(number, 113, 777.7), item('Mena', 280, 777.7), item('EUR', 330.2, 777.7),
        item('Účtovné obdobie', 367.9, 777.7), item('01. 09. 2026 - 30. 09. 2026', 457.9, 777.7),
      )
      items.push(...HEADER(753.8)); top = 717
    }
    items.push(...tableOps(ops, top))
    items.push(item('info@slsp.sk', 93.5, 19.2), item('M010_v203', 18.6, 24.1))
    if (p === st.pages.length - 1) items.push(item('Poznámka:', 34, 120))
    return { items }
  })
}
