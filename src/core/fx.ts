// Курсы: 1 base = rate quote. Поиск: прямая пара, обратная, через опорную валюту.
// Курс на дату = последний известный не позже этой даты; при равенстве дат выигрывает источник
// с меньшим числом приоритета (fx_source_priority); неизвестный источник хуже всех.
import type { FxRate, FxSourcePriority } from '../data/types'
import { invertRate, multiplyRates, ONE, parseRate, type Rate } from './money'

export class FxResolver {
  private byPair = new Map<string, FxRate[]>()
  private prio = new Map<string, number>()

  constructor(rates: FxRate[], priorities: FxSourcePriority[], private pivot: string | null) {
    for (const p of priorities) this.prio.set(p.source, p.priority)
    for (const r of rates) {
      const k = `${r.baseCurrencyKey}>${r.quoteCurrencyKey}`
      const l = this.byPair.get(k)
      if (l) l.push(r); else this.byPair.set(k, [r])
    }
  }

  private pick(base: string, quote: string, date: string): Rate | null {
    const list = this.byPair.get(`${base}>${quote}`)
    if (!list) return null
    let best: FxRate | null = null
    const pr = (s: string) => this.prio.get(s) ?? Number.POSITIVE_INFINITY
    for (const r of list) {
      if (r.rateDate > date) continue
      if (!best || r.rateDate > best.rateDate ||
        (r.rateDate === best.rateDate && (pr(r.source) < pr(best.source) ||
          (pr(r.source) === pr(best.source) && r.source < best.source)))) best = r
    }
    return best ? parseRate(best.rate) : null
  }

  private leg(from: string, to: string, date: string): Rate | null {
    const direct = this.pick(from, to, date)
    if (direct) return direct
    const inv = this.pick(to, from, date)
    return inv ? invertRate(inv) : null
  }

  /** Множитель: сумма в `from` × rate = сумма в `to`. null = «нет курса». */
  rate(from: string, to: string, date: string): Rate | null {
    if (from === to) return ONE
    const direct = this.leg(from, to, date)
    if (direct) return direct
    if (this.pivot && this.pivot !== from && this.pivot !== to) {
      const a = this.leg(from, this.pivot, date)
      const b = a && this.leg(this.pivot, to, date)
      if (a && b) return multiplyRates(a, b)
    }
    return null
  }
}
