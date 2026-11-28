// Подсказки «похожий контрагент»: неопознанное название из выписки сравнивается с именами и названиями справочника (без ИИ, по словам).
// Это только предложение: владелец отмечает согласие, и название записывается контрагенту как ещё один признак.
import type { CoreContext } from '../context'
import { applyCounterpartyFile, collectCounterpartyGroups, recognizeGroups, type CpFileResult } from './counterparties'
import type { ParsedStatement } from './types'

const STOP = new Set(['sro', 'as', 'spol', 'ltd', 'llc', 'gmbh', 'ba', 'sk', 'svk', 'the'])

/** Слова названия: без регистра и диакритики, хвост после первой запятой (город, адрес) отброшен. */
export function nameTokens(s: string): string[] {
  const head = s.split(',')[0] ?? s
  const t = head.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w && !STOP.has(w))
  return [...new Set(t)]
}

/** 0 = не похожи; иначе доля общих слов. Похожи, если слова одного названия целиком входят в другое (и есть слово от 3 букв) или общих слов не меньше 60%. */
export function similarity(a: string, b: string): number {
  const x = nameTokens(a), y = nameTokens(b)
  if (!x.length || !y.length) return 0
  const [small, big] = x.length <= y.length ? [x, y] : [y, x]
  const common = small.filter((w) => big.includes(w)).length
  const jac = common / (x.length + y.length - common)
  if (common === small.length && small.some((w) => w.length >= 3)) return Math.max(jac, 0.6)
  return jac >= 0.6 ? jac : 0
}

export interface SimilarPair { text: string; iban: string | null; candidate: string; score: number }

/** Для каждого неопознанного контрагента выписки лучший кандидат из справочника (имя или любое его название в выписках). */
export async function findSimilar(ctx: CoreContext, st: ParsedStatement): Promise<SimilarPair[]> {
  const groups = collectCounterpartyGroups(st)
  const found = await recognizeGroups(ctx, groups)
  const cps = await ctx.storage.list('counterparties')
  const names = new Map<string, string[]>()
  for (const c of cps) names.set(c.id, [c.name])
  for (const i of await ctx.storage.list('counterpartyIdentifiers')) if (i.kind === 'statement_name' && i.value) names.get(i.counterpartyId)?.push(i.value)
  const out: SimilarPair[] = []
  groups.forEach((g, k) => {
    if (found[k]) return
    let best: { name: string; score: number } | null = null
    for (const c of cps) {
      const s = Math.max(...(names.get(c.id) ?? []).map((n) => similarity(g.text, n)))
      if (s > 0 && (!best || s > best.score || (s === best.score && c.name.length < best.name.length))) best = { name: c.name, score: s }
    }
    if (best) out.push({ text: g.text, iban: g.iban, candidate: best.name, score: best.score })
  })
  return out.sort((a, b) => b.score - a.score || a.text.localeCompare(b.text))
}

/** Записать согласованные пары: название из выписки становится признаком существующего контрагента. */
export function acceptSimilar(ctx: CoreContext, pairs: { text: string; iban: string | null; candidate: string }[]): Promise<CpFileResult> {
  return applyCounterpartyFile(ctx, pairs.map((p, i) => ({ row: i + 2, text: p.text, resolved: p.candidate, newName: '', iban: p.iban })))
}
