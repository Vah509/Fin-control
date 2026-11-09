import { describe, expect, it } from 'vitest'
import {
  addDays, assertDate, convertMinor, endOfLocalDayMs, formatMinor, FxResolver, invertRate, isValidCountryTimeZone,
  isValidTimeZone, localDateOf, ONE, parseMinor, parseRate, startOfLocalDayMs,
} from '../src/core'
import { code, rate } from './helpers'

describe('деньги', () => {
  it('разбор и вывод без float', () => {
    expect(parseMinor('1245.58', 2)).toBe(124558)
    expect(parseMinor('-0.05', 2)).toBe(-5)
    expect(parseMinor('10', 2)).toBe(1000)
    expect(parseMinor('0.1', 2)).toBe(10)
    expect(formatMinor(124558, 2)).toBe('1245.58')
    expect(formatMinor(-5, 2)).toBe('-0.05')
    expect(formatMinor(7, 0)).toBe('7')
  })
  it('лишние знаки отвергаются, а не округляются', async () => {
    expect(await code(Promise.resolve().then(() => parseMinor('1.005', 2)))).toBe('INVALID_AMOUNT')
    expect(await code(Promise.resolve().then(() => parseMinor('abc', 2)))).toBe('INVALID_AMOUNT')
  })
  it('округление: 5 и больше от нуля, только при пересчёте', () => {
    const r = parseRate('0.5') // 1 единица = 0.5
    expect(convertMinor(1, 2, 2, r)).toBe(1)    // 0.5 коп -> 1
    expect(convertMinor(-1, 2, 2, r)).toBe(-1)  // симметрично
    expect(convertMinor(3, 2, 2, parseRate('0.4'))).toBe(1) // 1.2 -> 1
    expect(convertMinor(10000, 2, 2, parseRate('1.085'))).toBe(10850)
  })
  it('разные знаки после запятой у валют', () => {
    expect(convertMinor(1000, 2, 0, parseRate('1'))).toBe(10)
    expect(convertMinor(10, 0, 2, ONE)).toBe(1000)
  })
  it('курс: строка в рациональное число, обратный курс точный', () => {
    const inv = invertRate(parseRate('0.025'))
    expect(convertMinor(100000, 2, 2, inv)).toBe(4000000)
    expect(() => parseRate('0')).toThrow()
  })
})

describe('время и пояса', () => {
  it('начало дня в Братиславе: 1 октября 2026 = 22:00Z накануне (как в seed)', () => {
    expect(new Date(startOfLocalDayMs('2026-10-01', 'Europe/Bratislava')).toISOString()).toBe('2026-09-30T22:00:00.000Z')
  })
  it('переход на зимнее время: 25 октября 2026 длится 25 часов', () => {
    const a = startOfLocalDayMs('2026-10-25', 'Europe/Bratislava')
    const b = startOfLocalDayMs('2026-10-26', 'Europe/Bratislava')
    expect((b - a) / 3600000).toBe(25)
  })
  it('конец дня и локальная дата', () => {
    const end = endOfLocalDayMs('2026-10-31', 'Europe/Bratislava')
    expect(new Date(end).toISOString()).toBe('2026-10-31T22:59:59.999Z')
    expect(localDateOf(Date.parse('2026-10-31T22:30:00Z'), 'Europe/Bratislava')).toBe('2026-10-31')
    expect(localDateOf(Date.parse('2026-10-31T23:30:00Z'), 'Europe/Bratislava')).toBe('2026-11-01')
    expect(localDateOf(Date.parse('2026-10-31T23:30:00Z'), 'Europe/Kyiv')).toBe('2026-11-01')
  })
  it('проверки', () => {
    expect(isValidTimeZone('Europe/Kyiv')).toBe(true)
    expect(isValidTimeZone('Mars/Base')).toBe(false)
    expect(isValidCountryTimeZone('default')).toBe(true)
    expect(addDays('2026-02-28', 1)).toBe('2026-03-01')
    expect(() => assertDate('2026-02-30')).toThrow()
  })
})

describe('курсы', () => {
  const prios = [{ source: 'nbu', priority: 1 }, { source: 'manual', priority: 2 }]
  const conv = (fx: FxResolver, m: number, a: string, b: string, d: string) => {
    const r = fx.rate(a, b, d)
    return r ? convertMinor(m, 2, 2, r) : null
  }
  it('прямая и обратная пара; та же валюта', () => {
    const fx = new FxResolver([rate('1', '2026-10-01', 'eur', 'usd', '1.1')], [], null)
    expect(conv(fx, 10000, 'eur', 'usd', '2026-10-05')).toBe(11000)
    expect(conv(fx, 11000, 'usd', 'eur', '2026-10-05')).toBe(10000)
    expect(conv(fx, 5, 'eur', 'eur', '2026-10-05')).toBe(5)
  })
  it('последний известный не позже даты; будущий курс не берётся', () => {
    const fx = new FxResolver([
      rate('1', '2026-10-01', 'eur', 'usd', '1.1'), rate('2', '2026-10-10', 'eur', 'usd', '1.2'),
    ], [], null)
    expect(conv(fx, 10000, 'eur', 'usd', '2026-10-09')).toBe(11000)
    expect(conv(fx, 10000, 'eur', 'usd', '2026-10-10')).toBe(12000)
    expect(conv(fx, 10000, 'eur', 'usd', '2026-09-30')).toBeNull()
  })
  it('приоритет источников на одну дату', () => {
    const fx = new FxResolver([
      rate('1', '2026-10-01', 'eur', 'usd', '1.1', 'manual'), rate('2', '2026-10-01', 'eur', 'usd', '1.3', 'nbu'),
    ], prios, null)
    expect(conv(fx, 10000, 'eur', 'usd', '2026-10-01')).toBe(13000)
  })
  it('более свежий курс побеждает приоритет', () => {
    const fx = new FxResolver([
      rate('1', '2026-10-02', 'eur', 'usd', '1.1', 'manual'), rate('2', '2026-10-01', 'eur', 'usd', '1.3', 'nbu'),
    ], prios, null)
    expect(conv(fx, 10000, 'eur', 'usd', '2026-10-02')).toBe(11000)
  })
  it('через опорную валюту, если прямой пары нет', () => {
    const fx = new FxResolver([
      rate('1', '2026-10-01', 'eur', 'uah', '40'), rate('2', '2026-10-01', 'usd', 'uah', '38'),
    ], [], 'uah')
    expect(conv(fx, 3800, 'usd', 'eur', '2026-10-01')).toBe(3610 * 0 + Math.round((3800 * 38) / 40))
    const noPivot = new FxResolver([rate('1', '2026-10-01', 'eur', 'uah', '40'), rate('2', '2026-10-01', 'usd', 'uah', '38')], [], null)
    expect(conv(noPivot, 3800, 'usd', 'eur', '2026-10-01')).toBeNull()
  })
})
