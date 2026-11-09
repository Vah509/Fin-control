// Даты и часовые пояса. Время хранится в UTC (ISO); «конец дня» считается в поясе счёта.
import { fail } from './errors'

const cache = new Map<string, Intl.DateTimeFormat>()
function fmt(tz: string): Intl.DateTimeFormat {
  let f = cache.get(tz)
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    })
    cache.set(tz, f)
  }
  return f
}

export function isValidTimeZone(tz: string): boolean {
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return tz.length > 0 } catch { return false }
}
/** Для countries.timezone: имя пояса IANA или 'default'. */
export const isValidCountryTimeZone = (tz: string) => tz === 'default' || isValidTimeZone(tz)

function parts(ms: number, tz: string) {
  const p: Record<string, string> = {}
  for (const x of fmt(tz).formatToParts(new Date(ms))) p[x.type] = x.value
  return { y: +p.year!, m: +p.month!, d: +p.day!, h: +p.hour! % 24, mi: +p.minute!, s: +p.second! }
}
function offsetMs(ms: number, tz: string): number {
  const p = parts(ms, tz)
  return Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s) - Math.floor(ms / 1000) * 1000
}

export function assertDate(s: string, what = 'дата'): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s)
  if (m) {
    const d = new Date(Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!))
    if (d.getUTCFullYear() === +m[1]! && d.getUTCMonth() === +m[2]! - 1 && d.getUTCDate() === +m[3]!) return s
  }
  return fail('INVALID_DATE', `${what}: ожидается ГГГГ-ММ-ДД, получено ${s}`)
}

export function addDays(date: string, n: number): string {
  assertDate(date)
  const [y, m, d] = date.split('-').map(Number) as [number, number, number]
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10)
}

/** Момент начала календарного дня в поясе (мс UTC). */
export function startOfLocalDayMs(date: string, tz: string): number {
  assertDate(date)
  const [y, m, d] = date.split('-').map(Number) as [number, number, number]
  const guess = Date.UTC(y, m - 1, d)
  const t1 = guess - offsetMs(guess, tz)
  return guess - offsetMs(t1, tz)
}
/** Последняя миллисекунда календарного дня в поясе. */
export const endOfLocalDayMs = (date: string, tz: string) => startOfLocalDayMs(addDays(date, 1), tz) - 1

export function localDateOf(ms: number, tz: string): string {
  const p = parts(ms, tz)
  return `${String(p.y).padStart(4, '0')}-${String(p.m).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`
}

export function normalizeIso(value: string, what = 'время'): string {
  const ms = Date.parse(value)
  if (Number.isNaN(ms)) return fail('INVALID_DATE', `${what}: некорректное время ${value}`)
  return new Date(ms).toISOString()
}
export const iso = (ms: number) => new Date(ms).toISOString()
