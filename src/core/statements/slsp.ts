// Разбор PDF Slovenská sporiteľňa (счёт SPACE и аналогичные) по словам с координатами. Подробно: docs/STATEMENT-XLSX.md, раздел 7.
import { fail } from '../errors'
import { parseMinor } from '../money'
import type { PdfPage, PdfTextItem, StatementAccount, StatementCounterparty, StatementRow, ParsedStatement } from './types'

interface Line { y: number; items: PdfTextItem[]; text: string }

const WS = /[\s\u00a0\u202f\u2009]+/g
const clean = (s: string) => s.replace(WS, ' ').trim()

/** Слова страницы -> строки по Y (сверху вниз), слова в строке по X. Пустые и пробельные пропускаются. */
function toLines(page: PdfPage): Line[] {
  const items = page.items.filter((i) => clean(i.str) !== '').sort((a, b) => b.y - a.y || a.x - b.x)
  const lines: Line[] = []
  for (const it of items) {
    const last = lines[lines.length - 1]
    if (last && Math.abs(last.y - it.y) <= 1.5) last.items.push(it)
    else lines.push({ y: it.y, items: [it], text: '' })
  }
  for (const l of lines) { l.items.sort((a, b) => a.x - b.x); l.text = clean(l.items.map((i) => i.str).join(' ')) }
  return lines
}

/** '- 1 200,00' / '2 000,00' / с неразрывными пробелами -> минорные единицы. */
export function parseSkAmount(text: string): number {
  const t = text.replace(WS, '').replace(/[−–]/g, '-')
  const m = /^([-+]?)(\d+),(\d{2})$/.exec(t)
  if (!m) return fail('STATEMENT_PARSE', `не сумма: «${text}»`)
  return parseMinor(`${m[1] === '-' ? '-' : ''}${m[2]}.${m[3]}`, 2)
}

const isoDate = (d: string, m: string, y: string) => `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`
const DATE_RE = /(\d{1,2})\.\s*(\d{1,2})\.\s*(\d{4})/g
function parseDates(text: string): string[] {
  return [...text.matchAll(DATE_RE)].map((m) => isoDate(m[1]!, m[2]!, m[3]!))
}

interface Cols { descX: number; amountX: number; feeX: number; /** Infinity: у выписки нет колонки «Zostatok po transakcii» (бизнес-счёт) */ balX: number; top: number }

function findTable(lines: Line[]): Cols | null {
  const hi = lines.findIndex((l) => l.items.some((i) => i.str.trim() === 'Popis') && l.items.filter((i) => i.str.trim() === 'Suma').length >= 2)
  if (hi < 0) return null
  const h = lines[hi]!
  const sumas = h.items.filter((i) => i.str.trim() === 'Suma')
  const pop = h.items.find((i) => i.str.trim() === 'Popis')!
  const zos = h.items.find((i) => i.str.trim().startsWith('Zostatok'))   // нет у бизнес-счёта
  if (sumas.length < 2) return null
  // вторая строка шапки ("valuty zúčtovania ... po transakcii") ниже на ~11
  let top = h.y
  for (let k = hi + 1; k < lines.length && lines[k]!.y > h.y - 20; k++) top = lines[k]!.y
  return { descX: pop.x, amountX: sumas[0]!.x, feeX: sumas[1]!.x, balX: zos ? zos.x : Number.POSITIVE_INFINITY, top }
}

const STOP = (t: string) => /^Poznámka/.test(t) || t.includes('info@slsp.sk')

interface RawOp { valueDate: string; bookingDate: string; title: string; body: string[]; amount: string[]; fee: string[]; bal: string[] }

function collectOps(pages: PdfPage[]): RawOp[] {
  const ops: RawOp[] = []
  let cur: RawOp | null = null
  for (const page of pages) {
    const lines = toLines(page)
    const cols = findTable(lines)
    if (!cols) continue
    for (const l of lines) {
      if (l.y >= cols.top - 1) continue
      if (STOP(l.text)) break
      const dateZone: string[] = []; const desc: string[] = []
      const am: string[] = []; const fee: string[] = []; const bal: string[] = []
      for (const it of l.items) {
        const s = clean(it.str)
        if (it.x < 30) continue
        if (it.x < cols.descX - 5) dateZone.push(s)
        else if (it.x < cols.amountX - 12) desc.push(s)
        else if (it.x + it.w < cols.feeX) am.push(s)
        else if (it.x + it.w < cols.balX) fee.push(s)
        else bal.push(s)
      }
      const dz = dateZone.join(' ')
      const dm = /^(\d{2}\.\d{2}\.\d{4})\s*(\d{2}\.\d{2}\.\d{4})$/.exec(dz)   // в части PDF обе даты слиты в одно слово: «01.07.202601.07.2026»
      if (dm) {
        const [v, b] = parseDates(`${dm[1]} ${dm[2]}`)
        cur = { valueDate: v!, bookingDate: b!, title: clean(desc.join(' ')), body: [], amount: am, fee, bal }
        ops.push(cur)
        continue
      }
      if (!cur) continue
      if (desc.length) cur.body.push(clean(desc.join(' ')))
      cur.amount.push(...am); cur.fee.push(...fee); cur.bal.push(...bal)
    }
  }
  return ops
}

const CARD_LINE = /^Č\. k\. (\S+ \S+ \S+ \S+)\s*$/
const IBAN_LINE = /^([A-Z]{2}\d{2}[\d ]*\d)\s+BIC:\s*([A-Z0-9]+)/
/** длинный IBAN (например PT50…) переносит «BIC: …» на следующую строку */
const IBAN_ONLY = /^([A-Z]{2}\d{2}[\d ]*\d)\s*$/
const CARD_DT = /(\d{1,2})\.\s*(\d{1,2})\.\s*(\d{4})\s+(\d{1,2}:\d{2}(?::\d{2})?)\s*$/
const LABEL_LINE = /^[\p{L} ]{2,40}:(\s|$)/u   // «VS: …», «SS: …», «Referencia platiteľa: …» начинают служебную часть

function parseBody(title: string, body: string[]): { cp: StatementCounterparty; cardMask: string | null; time: string | null } {
  const ci = body.findIndex((b) => CARD_LINE.test(b))
  if (ci >= 0) {
    const cardMask = CARD_LINE.exec(body[ci]!)![1]!
    const rest = body.slice(ci + 1)
    const ti = rest.findIndex((b) => b.startsWith('Transakcia'))
    const merchantText = clean((ti >= 0 ? rest.slice(0, ti) : rest).join(' '))
    const m = CARD_DT.exec(merchantText)
    let time: string | null = null
    let name = merchantText
    if (m) {
      const t = m[4]!
      time = (t.length === 5 ? t + ':00' : t).padStart(8, '0')
      name = merchantText.slice(0, m.index).trim()
    }
    return { cp: { kind: 'card', name: name || title, iban: null }, cardMask, time }
  }
  const ii = body.findIndex((b, i) => IBAN_LINE.test(b) || (IBAN_ONLY.test(b) && (body[i + 1] ?? '').startsWith('BIC:')))
  if (ii >= 0) {
    const wrapped = !IBAN_LINE.test(body[ii]!)
    const iban = (wrapped ? IBAN_ONLY : IBAN_LINE).exec(body[ii]!)![1]!.replace(/ /g, '')
    const rest = body.slice(ii + (wrapped ? 2 : 1))
    const ni = rest.findIndex((b) => b.startsWith('Názov protiúčtu:'))
    let name = ''
    if (ni >= 0) {
      const parts = [rest[ni]!.replace(/^Názov protiúčtu:\s*/, '')]
      for (const b of rest.slice(ni + 1)) { if (LABEL_LINE.test(b)) break; parts.push(b) }
      name = clean(parts.join(' '))
    }
    return { cp: { kind: 'sepa', name: name || title, iban }, cardMask: null, time: null }
  }
  return { cp: { kind: 'other', name: title, iban: null }, cardMask: null, time: null }
}

interface Header { number: string; title: string; holderName: string; currency: string; periodStart: string; periodEnd: string; opening: string; deposits: string; withdrawals: string; closing: string }

function parseHeader(page: PdfPage, tableTop: number): Header | null {
  const lines = toLines(page).filter((l) => l.y > tableTop)
  const h: Record<string, string> = {}
  const rules: [string, RegExp][] = [
    ['title', /^Výpis z Účtu:\s*(.+)$/], ['holderName', /^Názov Účtu\s+(.+)$/], ['number', /^Číslo Účtu\s+(.+)$/], ['currency', /^Mena\s+(\S+)$/],
    ['period', /^Účtovné obdobie\s+(.+)$/], ['opening', /^Počiatočný stav Účtu\s+(.+)$/], ['deposits', /^Vklady spolu\s+(.+)$/],
    ['withdrawals', /^Výbery spolu\s+(.+)$/], ['closing', /^Konečný stav Účtu\s+(.+)$/],
  ]
  for (const l of lines) {
    const left = clean(l.items.filter((i) => i.x < 300).map((i) => i.str).join(' '))
    const right = clean(l.items.filter((i) => i.x >= 300).map((i) => i.str).join(' '))
    for (const g of [left, right]) for (const [k, re] of rules) { const m = re.exec(g); if (m && !(k in h)) h[k] = m[1]! }
  }
  const [ps, pe] = parseDates(h.period ?? '')
  if (!h.number || !h.currency || !h.opening || !h.deposits || !h.withdrawals || !h.closing || !ps || !pe) return null
  return {
    number: h.number.replace(/\s/g, ''), title: h.title ?? '', holderName: h.holderName ?? '', currency: h.currency,
    periodStart: ps, periodEnd: pe, opening: h.opening, deposits: h.deposits, withdrawals: h.withdrawals, closing: h.closing,
  }
}

export function parseSlspStatement(pages: PdfPage[]): ParsedStatement {
  const first = pages[0]
  const cols = first ? findTable(toLines(first)) : null
  const hdr = first && cols ? parseHeader(first, cols.top) : null
  if (!first || !cols || !hdr) return fail('STATEMENT_UNRECOGNIZED', 'это не выписка Slovenská sporiteľňa (нет шапки или таблицы операций на первой странице)')

  for (const [i, p] of pages.slice(1).entries()) {
    const l = toLines(p).find((x) => x.items.some((it) => it.str.trim() === 'Číslo Účtu'))
    const m = l && /Číslo Účtu\s+(SK[\d ]+?)\s+Mena/.exec(l.text)
    if (m && m[1]!.replace(/\s/g, '') !== hdr.number) fail('STATEMENT_PARSE', `страница ${i + 2}: другой номер счёта`)
  }

  const key = hdr.number.slice(-4)
  const hasBalance = cols.balX !== Number.POSITIVE_INFINITY
  // Бизнес-счёт без колонки остатка: остаток после операции считается от начального; сверка по итогам шапки остаётся честной (сумма операций должна дать конечный остаток и итоги вкладов и выборов)
  let running = parseSkAmount(hdr.opening)
  const rows: StatementRow[] = collectOps(pages).map((op, idx) => {
    const n = idx + 1
    if (!op.amount.length || (hasBalance && !op.bal.length)) fail('STATEMENT_PARSE', `строка ${n}: не найдена сумма${hasBalance ? ' или остаток' : ''}`, { n })
    const { cp, cardMask, time } = parseBody(op.title, op.body)
    const amountMinor = parseSkAmount(op.amount.join(' ')); const feeMinor = op.fee.length ? parseSkAmount(op.fee.join(' ')) : 0
    running += amountMinor + feeMinor
    return {
      n, accountKey: key, valueDate: op.valueDate, bookingDate: op.bookingDate, time, title: op.title, counterparty: cp, cardMask,
      description: clean([op.title, ...op.body].join(' ')),
      amountMinor, feeMinor,
      balanceAfterMinor: hasBalance ? parseSkAmount(op.bal.join(' ')) : running, currency: hdr.currency,
    }
  })

  const account: StatementAccount = {
    number: hdr.number, key, title: hdr.title, holderName: hdr.holderName, currency: hdr.currency,
    periodStart: hdr.periodStart, periodEnd: hdr.periodEnd,
    openingMinor: parseSkAmount(hdr.opening), closingMinor: parseSkAmount(hdr.closing),
    depositsMinor: Math.abs(parseSkAmount(hdr.deposits)), withdrawalsMinor: Math.abs(parseSkAmount(hdr.withdrawals)), rows,
  }
  return { bank: 'slsp', accounts: [account] }
}
