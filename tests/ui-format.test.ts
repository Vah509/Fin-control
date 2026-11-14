import { describe, expect, it } from 'vitest'
import { fail } from '../src/core'
import { dateRu, errorText, lastDayOfPreviousMonth, localInputToIso, money, parseAmountInput, toLocalInput, todayLocal } from '../src/ui/format'

describe('форматирование для экранов', () => {
  it('деньги: группы разрядов, запятая, настоящий минус', () => {
    expect(money(124558, 2)).toBe('1\u00a0245,58')
    expect(money(-5, 2)).toBe('−0,05')
    expect(money(1000000, 0)).toBe('1\u00a0000\u00a0000')
  })
  it('ввод суммы: запятая, пробелы, лишние знаки, пусто', () => {
    expect(parseAmountInput('1 245,58', 2)).toEqual({ minor: 124558 })
    expect(parseAmountInput('-12.5', 2)).toEqual({ minor: -1250 })
    expect(parseAmountInput('', 2)).toBeNull()
    expect(parseAmountInput('1,234', 2)).toHaveProperty('error')
    expect(parseAmountInput('abc', 2)).toHaveProperty('error')
  })
  it('ошибки ядра и хранилища переводятся на понятный язык', () => {
    let e: unknown
    try { fail('PERIOD_LOCKED', 'период закрыт по 2026-09-30') } catch (x) { e = x }
    expect(errorText(e)).toContain('Период закрыт')
    expect(errorText(new Error('AUTH: Invalid login credentials'))).toBe('Неверная почта или пароль')
    expect(errorText(new TypeError('Failed to fetch'))).toContain('онлайн')
    expect(errorText(new Error('STORAGE: что-то'))).toContain('базы данных')
  })
  it('даты', () => {
    expect(dateRu('2026-11-09')).toBe('09.11.2026')
    expect(todayLocal(new Date(2026, 10, 9))).toBe('2026-11-09')
    expect(toLocalInput(new Date(2026, 10, 9, 7, 5))).toBe('2026-11-09T07:05')
    expect(localInputToIso('')).toBeNull()
    expect(localInputToIso('2026-11-09T07:05')).toMatch(/Z$/)
    expect(lastDayOfPreviousMonth(new Date(2026, 10, 9))).toBe('2026-10-31')
    expect(lastDayOfPreviousMonth(new Date(2026, 2, 1))).toBe('2026-02-28')
  })
})

import { rateChange } from '../src/ui/format'
describe('rateChange', () => {
  it('рост, падение, ноль, нет данных', () => {
    expect(rateChange(12, 2)).toEqual({ text: '▲ +0,12', dir: 'up' })
    expect(rateChange(-15, 2)).toEqual({ text: '▼ −0,15', dir: 'down' })
    expect(rateChange(0, 2)).toEqual({ text: '0,00', dir: 'none' })
    expect(rateChange(null, 4)).toEqual({ text: '—', dir: 'none' })
    expect(rateChange(5, 4).text).toBe('▲ +0,0005')
  })
})
