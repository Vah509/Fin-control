// Автообновление курсов: если на сегодня курса нет, берём курс у банка (по очереди, пока не получим).
// Правило (решение 14.11.2026, заменило консервативный курс 13.11.2026): везде средний курс банка,
// (покупка + продажа) / 2; один и тот же курс для показа на Главной и для всех пересчётов.
// Курс сохраняется в fx_rates с датой дня и источником; прошлые срезы не меняются (принцип 5).
// Сеть вне ядра: источники курсов передаются снаружи (интерфейс RateSource).
import type { Currency, FxRate } from '../data/types'
import type { CoreContext } from './context'
import { readSettings } from './settings'

/** Пара от банка: банк покупает A за B по `buy` и продаёт A за B по `sell` (B за 1 A). Коды ISO заглавными. */
export interface BankPair { a: string; b: string; buy: number | null; sell: number | null }

export interface RateSource {
  /** Имя источника в fx_rates.source (меньше по алфавиту = важнее при равных датах: manual < monobank < privatbank). */
  source: string
  fetchPairs(): Promise<BankPair[]>
}

export interface NewRate { baseKey: string; quoteKey: string; rate: string }

const num = (v: number | null | undefined): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0
const fmt = (v: number) => v.toFixed(8)

/** Средний курс пары: (покупка + продажа) / 2; нужны оба значения. */
const mid = (p: BankPair | undefined): number | null => (p && num(p.buy) && num(p.sell) ? (p.buy + p.sell) / 2 : null)

/**
 * Курс для пересчёта валюты `cur` в базовую `base` по парам банка: средний между покупкой и продажей.
 * 1) пара base/cur напрямую; 2) пара cur/base; 3) через общую валюту P (обычно UAH): mid(cur/P) / mid(base/P).
 */
export function averageRate(base: Currency, cur: Currency, pairs: BankPair[]): NewRate | null {
  const B = base.code.toUpperCase(), C = cur.code.toUpperCase()
  const find = (a: string, b: string) => pairs.find((p) => p.a.toUpperCase() === a && p.b.toUpperCase() === b)
  const bc = mid(find(B, C))
  if (bc) return { baseKey: base.key, quoteKey: cur.key, rate: fmt(bc) }
  const cb = mid(find(C, B))
  if (cb) return { baseKey: cur.key, quoteKey: base.key, rate: fmt(cb) }
  const pivots = new Set<string>()
  for (const p of pairs) { pivots.add(p.a.toUpperCase()); pivots.add(p.b.toUpperCase()) }
  pivots.delete(B); pivots.delete(C)
  for (const P of [...pivots].sort((x, y) => (x === 'UAH' ? -1 : y === 'UAH' ? 1 : x.localeCompare(y)))) {
    const cp = mid(find(C, P)), bp = mid(find(B, P))
    if (cp && bp) return { baseKey: cur.key, quoteKey: base.key, rate: fmt(cp / bp) }
  }
  return null
}

export interface FxFreshness {
  baseKey: string | null
  /** Валюты активных счетов, кроме базовой. */
  needed: string[]
  /** Из них те, у кого нет курса с датой `date` (любой источник, включая ручной). */
  stale: string[]
}

export async function fxFreshness(ctx: CoreContext, date: string): Promise<FxFreshness> {
  const [accounts, settingsRows, rates] = await Promise.all([
    ctx.storage.list('accounts'), ctx.storage.list('appSettings'), ctx.storage.listFxRates({ toDate: date }),
  ])
  const base = readSettings(settingsRows).baseCurrency
  if (!base) return { baseKey: null, needed: [], stale: [] }
  const needed = [...new Set(accounts.filter((a) => !a.archivedAt && a.currencyKey !== base).map((a) => a.currencyKey))].sort()
  const stale = needed.filter((c) => !rates.some((r) => r.rateDate === date &&
    ((r.baseCurrencyKey === base && r.quoteCurrencyKey === c) || (r.baseCurrencyKey === c && r.quoteCurrencyKey === base))))
  return { baseKey: base, needed, stale }
}

export type FxRefreshStatus = 'fresh' | 'updated' | 'partial' | 'failed' | 'skipped'
export interface FxRefreshResult {
  status: FxRefreshStatus
  /** Источники, чьи курсы записаны. */
  sources: string[]
  /** Валюты, для которых курса получить не удалось. */
  missing: string[]
  errors: string[]
}

/** Проверяет курсы на `date`; недостающие запрашивает у банков по очереди и сохраняет. Только владелец. */
export async function refreshFxRates(ctx: CoreContext, date: string, providers: RateSource[]): Promise<FxRefreshResult> {
  const fr = await fxFreshness(ctx, date)
  if (!fr.baseKey || fr.stale.length === 0) return { status: 'fresh', sources: [], missing: [], errors: [] }
  if (!ctx.actor.isOwner) return { status: 'skipped', sources: [], missing: fr.stale, errors: [] }

  const currencies = await ctx.storage.list('currencies')
  const byKey = new Map<string, Currency>(currencies.map((c) => [c.key, c]))
  const base = byKey.get(fr.baseKey)
  if (!base) return { status: 'failed', sources: [], missing: fr.stale, errors: [`валюта ${fr.baseKey} не найдена`] }

  let remaining = [...fr.stale]
  const got: { source: string; rate: NewRate }[] = []
  const errors: string[] = []
  for (const p of providers) {
    if (remaining.length === 0) break
    try {
      const pairs = await p.fetchPairs()
      const still: string[] = []
      for (const key of remaining) {
        const cur = byKey.get(key)
        const r = cur ? averageRate(base, cur, pairs) : null
        if (r) got.push({ source: p.source, rate: r }); else still.push(key)
      }
      remaining = still
    } catch (e) {
      errors.push(`${p.source}: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  if (got.length === 0) return { status: 'failed', sources: [], missing: remaining, errors }

  // Повторный запуск в тот же день обновляет те же строки (уникальность: пара + дата + источник).
  const existing = await ctx.storage.listFxRates({ toDate: date })
  const rows: FxRate[] = got.map(({ source, rate }) => {
    const same = existing.find((r) => r.rateDate === date && r.source === source &&
      r.baseCurrencyKey === rate.baseKey && r.quoteCurrencyKey === rate.quoteKey)
    return { id: same?.id ?? ctx.newId(), rateDate: date, baseCurrencyKey: rate.baseKey, quoteCurrencyKey: rate.quoteKey, rate: rate.rate, source }
  })
  await ctx.storage.applyBatch({ put: { fxRates: rows } })
  return {
    status: remaining.length === 0 ? 'updated' : 'partial',
    sources: [...new Set(got.map((g) => g.source))], missing: remaining, errors,
  }
}
