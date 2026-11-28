// Момент записи операции выписки: 12:00 по поясу счёта плюс номер строки в секундах (порядок внутри дня; решение владельца).
import type { Account, Country } from '../../data/types'
import { readSettings, resolveTimeZone } from '../settings'
import { iso, startOfLocalDayMs } from '../time'

const HOUR = 3_600_000

export function statementBookedAt(acc: Account, date: string, n: number, countries: Country[], settings: ReturnType<typeof readSettings>): string {
  return iso(startOfLocalDayMs(date, resolveTimeZone(acc, countries, settings)) + 12 * HOUR + n * 1000)
}
