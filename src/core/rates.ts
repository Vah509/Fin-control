// Курсы для показа на главной: EUR/UAH, USD/UAH, EUR/USD (1 первая валюта = N второй) на дату и изменение
// к предыдущему значению. Берутся сохранённые курсы (прямая, обратная пара, через опорную валюту).
import type { CoreContext } from './context'
import { FxResolver } from './fx'
import { convertMinor } from './money'
import { readSettings } from './settings'
import { assertDate } from './time'

export const DISPLAY_PAIRS: { from: string; to: string; digits: number }[] = [
  { from: 'eur', to: 'uah', digits: 2 },
  { from: 'usd', to: 'uah', digits: 2 },
  { from: 'eur', to: 'usd', digits: 4 },
]

export interface DisplayRate {
  from: string; to: string
  /** Знаков после запятой в показе (и масштаб целых чисел ниже). */
  digits: number
  /** Курс на дату, целое число в единицах 10^-digits; null = нет курса. */
  valueScaled: number | null
  /** Предыдущее значение (на последнюю более раннюю дату с курсом); null = нет. */
  previousScaled: number | null
  previousDate: string | null
  /** valueScaled - previousScaled; null, если одного из них нет. */
  deltaScaled: number | null
}

export async function getDisplayRates(ctx: CoreContext, date: string): Promise<DisplayRate[]> {
  assertDate(date)
  const [rates, prios, settingsRows] = await Promise.all([
    ctx.storage.listFxRates({ toDate: date }), ctx.storage.list('fxSourcePriorities'), ctx.storage.list('appSettings'),
  ])
  const fx = new FxResolver(rates, prios, readSettings(settingsRows).fxPivotCurrency)
  const dates = [...new Set(rates.map((r) => r.rateDate))].sort().reverse()   // от новых к старым, все ≤ date
  const latest = dates[0] ?? null
  const scaled = (from: string, to: string, digits: number, on: string): number | null => {
    const r = fx.rate(from, to, on)
    return r ? convertMinor(1, 0, digits, r) : null
  }
  return DISPLAY_PAIRS.map(({ from, to, digits }) => {
    const valueScaled = scaled(from, to, digits, date)
    let previousScaled: number | null = null, previousDate: string | null = null
    for (const d of dates) {
      if (latest === null || d >= latest) continue
      const v = scaled(from, to, digits, d)
      if (v !== null) { previousScaled = v; previousDate = d; break }
    }
    return {
      from, to, digits, valueScaled, previousScaled, previousDate,
      deltaScaled: valueScaled !== null && previousScaled !== null ? valueScaled - previousScaled : null,
    }
  })
}
