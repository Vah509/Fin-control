// Деньги: целые минорные единицы (number, safe integer) без float.
// Курсы: точные рациональные числа (bigint). Округление: 5 и больше — от нуля, только при пересчёте.
import { fail } from './errors'

export function assertMinor(v: number, what = 'сумма'): number {
  if (!Number.isSafeInteger(v)) fail('INVALID_AMOUNT', `${what} должна быть целым числом минорных единиц`)
  return v
}

/** '1245.58' -> 124558. Лишние знаки после запятой не округляются молча, а отвергаются. */
export function parseMinor(text: string, decimals: number): number {
  const m = /^(-?)(\d+)(?:\.(\d+))?$/.exec(text.trim())
  if (!m) return fail('INVALID_AMOUNT', `не число: ${text}`)
  const frac = m[3] ?? ''
  if (frac.length > decimals) fail('INVALID_AMOUNT', `больше ${decimals} знаков после запятой: ${text}`)
  const digits = BigInt(m[2]! + frac.padEnd(decimals, '0'))
  const v = Number(m[1] === '-' ? -digits : digits)
  return assertMinor(v)
}

export function formatMinor(minor: number, decimals: number): string {
  const neg = minor < 0
  const s = String(Math.abs(minor)).padStart(decimals + 1, '0')
  const int = s.slice(0, s.length - decimals)
  const frac = decimals > 0 ? '.' + s.slice(s.length - decimals) : ''
  return (neg ? '-' : '') + int + frac
}

export interface Rate { num: bigint; den: bigint }
export const ONE: Rate = { num: 1n, den: 1n }

export function parseRate(text: string): Rate {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(text.trim())
  if (!m) return fail('INVALID_AMOUNT', `некорректный курс: ${text}`)
  const frac = m[2] ?? ''
  const num = BigInt(m[1]! + frac)
  if (num <= 0n) fail('INVALID_AMOUNT', 'курс должен быть больше нуля')
  return { num, den: 10n ** BigInt(frac.length) }
}
export const invertRate = (r: Rate): Rate => ({ num: r.den, den: r.num })
export const multiplyRates = (a: Rate, b: Rate): Rate => ({ num: a.num * b.num, den: a.den * b.den })

function divRoundHalfAwayFromZero(n: bigint, d: bigint): bigint {
  const neg = n < 0n
  const abs = neg ? -n : n
  let q = abs / d
  if ((abs % d) * 2n >= d) q += 1n
  return neg ? -q : q
}

/** Пересчёт суммы в минорных единицах: 1 единица `from` = rate единиц `to`. Единственное место округления. */
export function convertMinor(minor: number, fromDecimals: number, toDecimals: number, rate: Rate): number {
  const n = BigInt(minor) * rate.num * 10n ** BigInt(toDecimals)
  const d = rate.den * 10n ** BigInt(fromDecimals)
  return assertMinor(Number(divRoundHalfAwayFromZero(n, d)))
}
