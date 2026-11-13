// Курсы валют из открытых API банков. Только сеть и разбор ответа; правила выбора курса в ядре (core/fxUpdate.ts).
import type { BankPair, RateSource } from '../core'

const ISO: Record<number, string> = { 980: 'UAH', 840: 'USD', 978: 'EUR', 985: 'PLN', 826: 'GBP', 756: 'CHF', 203: 'CZK' }

/** monobank: https://api.monobank.ua/bank/currency (лимит: 1 запрос в минуту). */
export function parseMonobank(json: unknown): BankPair[] {
  if (!Array.isArray(json)) throw new Error('неожиданный ответ monobank')
  const out: BankPair[] = []
  for (const x of json as Record<string, unknown>[]) {
    const a = ISO[Number(x.currencyCodeA)], b = ISO[Number(x.currencyCodeB)]
    if (!a || !b) continue
    const buy = typeof x.rateBuy === 'number' ? x.rateBuy : null
    const sell = typeof x.rateSell === 'number' ? x.rateSell : null
    if (buy === null && sell === null) continue   // только rateCross: пропускаем
    out.push({ a, b, buy, sell })
  }
  return out
}

/** ПриватБанк: https://api.privatbank.ua/p24api/pubinfo?json&exchange&coursid=11 (безналичный курс; пары к UAH). */
export function parsePrivat(json: unknown): BankPair[] {
  if (!Array.isArray(json)) throw new Error('неожиданный ответ ПриватБанка')
  const out: BankPair[] = []
  for (const x of json as Record<string, unknown>[]) {
    const a = typeof x.ccy === 'string' ? x.ccy.toUpperCase() : '', b = typeof x.base_ccy === 'string' ? x.base_ccy.toUpperCase() : ''
    const buy = Number(x.buy), sell = Number(x.sale)
    if (!a || !b) continue
    out.push({ a, b, buy: Number.isFinite(buy) && buy > 0 ? buy : null, sell: Number.isFinite(sell) && sell > 0 ? sell : null })
  }
  return out
}

async function getJson(url: string, timeoutMs = 8000): Promise<unknown> {
  const ctl = new AbortController()
  const t = setTimeout(() => ctl.abort(), timeoutMs)
  try {
    const r = await fetch(url, { signal: ctl.signal, headers: { accept: 'application/json' } })
    if (r.status === 429) throw new Error('слишком частые запросы (429)')
    if (!r.ok) throw new Error(`ответ ${r.status}`)
    return await r.json()
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') throw new Error('нет ответа (время вышло)')
    if (e instanceof TypeError) throw new Error('запрос не прошёл (нет связи или банк не разрешает запрос из приложения)')
    throw e
  } finally { clearTimeout(t) }
}

export const monobankSource: RateSource = {
  source: 'monobank',
  fetchPairs: async () => parseMonobank(await getJson('https://api.monobank.ua/bank/currency')),
}
export const privatbankSource: RateSource = {
  source: 'privatbank',
  fetchPairs: async () => parsePrivat(await getJson('https://api.privatbank.ua/p24api/pubinfo?json&exchange&coursid=11')),
}
/** Порядок опроса: сначала monobank, затем ПриватБанк. */
export const BANK_SOURCES: RateSource[] = [monobankSource, privatbankSource]
