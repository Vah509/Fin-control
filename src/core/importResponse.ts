// Ответ ИИ-чата: извлечение JSON из текста, проверка схемы, склейка частей, сверка двух ответов.
// Чату не доверяем: здесь только форма; арифметику и сопоставления проверяет importReview.ts.
import type { ImportStoredResponse, Json } from '../data/types'
import { fail } from './errors'

export interface ParsedRow {
  n: number; bookedAt: string; amount: string; currency: string
  original: { amount: string; currency: string } | null
  balanceAfter: string | null; description: string; bankCategory: string | null
  cpStatus: string; cpKey: string | null; rawName: string | null; linkedMask: string | null; hints: string[]
}
export interface ParsedStatement {
  accountKey: string | null; mask: string | null; currency: string | null
  periodStart: string | null; periodEnd: string | null
  opening: string | null; closing: string | null; rowsTotal: number | null
  chatIncome: string | null; chatExpense: string | null
  rows: ParsedRow[]
}
export interface ParsedIssue { code: string; scope: string; ref: string; details: Record<string, unknown> }
export interface ImportDoc {
  version: number; taskId: string; part: number; parts: number; aiName: string
  statements: ParsedStatement[]
  newIdentifiers: { counterpartyKey: string; kind: string; value: string }[]
  issues: ParsedIssue[]
}

type Obj = Record<string, unknown>
const bad = (path: string, what: string): never => fail('IMPORT_INVALID', `${path}: ${what}`)
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)
const obj = (v: unknown, path: string): Obj => (isObj(v) ? v : bad(path, 'ожидается объект'))
const arr = (v: unknown, path: string): unknown[] => (Array.isArray(v) ? v : bad(path, 'ожидается список'))
const str = (v: unknown, path: string): string => (typeof v === 'string' ? v : bad(path, 'ожидается строка'))
const optStr = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v : typeof v === 'number' ? String(v) : null)
const int = (v: unknown, path: string): number => (Number.isInteger(v) ? (v as number) : bad(path, 'ожидается целое число'))

/** Любой JSON-объект в тексте: блоки ```json, затем весь текст, затем от первой «{» до последней «}». */
export function extractJsonObjects(text: string): unknown[] {
  const out: unknown[] = []
  for (const m of text.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)) {
    try { const v = JSON.parse(m[1]!); if (isObj(v)) out.push(v) } catch { /* не JSON */ }
  }
  if (out.length) return out
  for (const cand of [text.trim(), text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)]) {
    try { const v = JSON.parse(cand); if (isObj(v)) return [v] } catch { /* дальше */ }
  }
  return fail('IMPORT_INVALID', 'в тексте не найден JSON')
}

export function validateImportDoc(raw: unknown): ImportDoc {
  const d = obj(raw, 'ответ')
  if (d['format'] !== 'fin-control-import') bad('format', 'ожидается fin-control-import')
  const version = int(d['version'], 'version')
  const part = d['part'] === undefined ? 1 : int(d['part'], 'part')
  const parts = d['parts'] === undefined ? 1 : int(d['parts'], 'parts')
  if (part < 1 || parts < 1 || part > parts) bad('part', 'некорректные part и parts')
  const statements = arr(d['statements'], 'statements').map((s, i) => {
    const p = `statements[${i}]`, o = obj(s, p)
    const acc = isObj(o['account']) ? (o['account'] as Obj) : {}
    const hints = isObj(acc['hints']) ? (acc['hints'] as Obj) : {}
    const period = isObj(o['period']) ? (o['period'] as Obj) : {}
    const totals = isObj(o['totals']) ? (o['totals'] as Obj) : {}
    const checks = isObj(o['checks']) ? (o['checks'] as Obj) : {}
    const rows = arr(o['rows'], `${p}.rows`).map((r, j): ParsedRow => {
      const q = `${p}.rows[${j}]`, x = obj(r, q)
      const cp = isObj(x['counterparty']) ? (x['counterparty'] as Obj) : {}
      const orig = isObj(x['original']) ? (x['original'] as Obj) : null
      return {
        n: int(x['n'], `${q}.n`), bookedAt: str(x['booked_at'], `${q}.booked_at`), amount: str(x['amount'], `${q}.amount`),
        currency: str(x['currency'], `${q}.currency`).toLowerCase(),
        original: orig && optStr(orig['amount']) && optStr(orig['currency']) ? { amount: optStr(orig['amount'])!, currency: optStr(orig['currency'])!.toLowerCase() } : null,
        balanceAfter: optStr(x['balance_after']), description: optStr(x['description']) ?? '', bankCategory: optStr(x['bank_category']),
        cpStatus: optStr(cp['status']) ?? 'unknown', cpKey: optStr(cp['key']), rawName: optStr(cp['raw_name']),
        linkedMask: optStr(x['linked_mask']), hints: Array.isArray(x['hints']) ? (x['hints'] as unknown[]).filter((h): h is string => typeof h === 'string') : [],
      }
    })
    return {
      accountKey: optStr(acc['key']), mask: optStr(hints['mask']) ?? optStr(hints['number_tail']), currency: optStr(hints['currency'])?.toLowerCase() ?? null,
      periodStart: optStr(period['start']), periodEnd: optStr(period['end']),
      opening: optStr(o['opening_balance']), closing: optStr(o['closing_balance']),
      rowsTotal: Number.isInteger(checks['rows_total']) ? (checks['rows_total'] as number) : null,
      chatIncome: optStr(totals['income']), chatExpense: optStr(totals['expense']), rows,
    }
  })
  const newIdentifiers = (Array.isArray(d['new_identifiers']) ? d['new_identifiers'] : []).filter(isObj).map((x) => ({
    counterpartyKey: optStr(x['counterparty_key']) ?? '', kind: optStr(x['kind']) ?? 'statement_name', value: optStr(x['value']) ?? '',
  })).filter((x) => x.counterpartyKey && x.value)
  const issues = (Array.isArray(d['issues']) ? d['issues'] : []).filter(isObj).map((x): ParsedIssue => ({
    code: optStr(x['code']) ?? '?', scope: optStr(x['scope']) ?? '', ref: optStr(x['ref']) ?? '', details: isObj(x['details']) ? (x['details'] as Obj) : {},
  }))
  return { version, taskId: str(d['task_id'], 'task_id'), part, parts, aiName: optStr(d['ai_name']) ?? 'не указан', statements, newIdentifiers, issues }
}

/** SHA-256 канонического текста JSON: защита от повторной загрузки того же ответа. */
export async function hashJson(v: unknown): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(v)))
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

export interface ResponseGroup { key: string; aiName: string; parts: number; have: number[]; complete: boolean; doc: ImportDoc | null; receivedAt: string }

/** Ответы одного чата (одинаковые ai_name и parts) собираются в группу; полная группа склеивается в один документ. */
export function groupResponses(list: ImportStoredResponse[]): ResponseGroup[] {
  const groups = new Map<string, { docs: ImportDoc[]; receivedAt: string }>()
  for (const r of [...list].sort((a, b) => a.receivedAt.localeCompare(b.receivedAt))) {
    if (r.doc === null) continue
    const doc = validateImportDoc(r.doc)
    const key = `${doc.aiName}|${doc.parts}`
    const g = groups.get(key) ?? { docs: [], receivedAt: r.receivedAt }
    g.docs.push(doc); groups.set(key, g)
  }
  return [...groups].map(([key, g]) => {
    const first = g.docs[0]!
    const byPart = new Map(g.docs.map((d) => [d.part, d]))
    const have = [...byPart.keys()].sort((a, b) => a - b)
    const complete = have.length === first.parts && have.every((p, i) => p === i + 1)
    return { key, aiName: first.aiName, parts: first.parts, have, complete, receivedAt: g.receivedAt, doc: complete ? mergeParts([...byPart.entries()].sort((a, b) => a[0] - b[0]).map((e) => e[1])) : null }
  })
}

function mergeParts(docs: ImportDoc[]): ImportDoc {
  if (docs.length === 1) return docs[0]!
  const merged: ParsedStatement[] = []
  for (const d of docs) for (const s of d.statements) {
    const same = merged.find((m) => (m.mask ?? m.accountKey) === (s.mask ?? s.accountKey))
    if (!same) { merged.push({ ...s, rows: [...s.rows] }); continue }
    same.rows.push(...s.rows)
    same.closing = s.closing ?? same.closing
    same.rowsTotal = same.rowsTotal !== null && s.rowsTotal !== null ? same.rowsTotal + s.rowsTotal : null
  }
  return { ...docs[0]!, part: 1, statements: merged, newIdentifiers: docs.flatMap((d) => d.newIdentifiers), issues: docs.flatMap((d) => d.issues) }
}

/** Сверка двух ответов разных чатов: что отличается по картам, остаткам и строкам. Пустой список = совпадают. */
export function crossCheck(a: ImportDoc, b: ImportDoc): string[] {
  const out: string[] = []
  const key = (s: ParsedStatement) => s.mask ?? s.accountKey ?? '?'
  const bm = new Map(b.statements.map((s) => [key(s), s]))
  for (const s of a.statements) {
    const o = bm.get(key(s)); bm.delete(key(s))
    if (!o) { out.push(`карта ${key(s)}: нет во втором ответе`); continue }
    if (s.rows.length !== o.rows.length) out.push(`карта ${key(s)}: строк ${s.rows.length} и ${o.rows.length}`)
    if (s.closing !== o.closing) out.push(`карта ${key(s)}: остаток на конец ${s.closing ?? '—'} и ${o.closing ?? '—'}`)
    const sig = (r: ParsedRow) => `${r.bookedAt}|${r.amount}|${r.currency}`
    const cnt = new Map<string, number>()
    for (const r of s.rows) cnt.set(sig(r), (cnt.get(sig(r)) ?? 0) + 1)
    for (const r of o.rows) cnt.set(sig(r), (cnt.get(sig(r)) ?? 0) - 1)
    const diff = [...cnt].filter(([, v]) => v !== 0)
    if (diff.length) out.push(`карта ${key(s)}: различаются строки (${diff.length}): ${diff.slice(0, 3).map(([k]) => k).join('; ')}`)
  }
  for (const k of bm.keys()) out.push(`карта ${k}: нет в первом ответе`)
  return out
}

export type { Json }
