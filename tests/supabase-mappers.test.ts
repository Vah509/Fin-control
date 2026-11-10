import { describe, expect, it } from 'vitest'
import { auditFromRow, auditToRow, fromRow, toRow, bytesToPgHex, pgHexToBytes, numericToMinor, SPECS, WRITE_ORDER } from '../src/data/supabase/columns'
import { ENTITY_NAMES } from '../src/data/types'
import type { Transaction } from '../src/data/types'

const env = {
  decimals: (k: string) => ({ eur: 2, uah: 2, jpy: 0, kwd: 3 } as Record<string, number>)[k] ?? 2,
  accountCurrency: (id: string) => (id === 'acc-jpy' ? 'jpy' : 'eur'),
}
const base: Transaction = {
  id: 't', accountId: 'acc', counterpartyId: null, importId: null, source: 'manual', bookedAt: '2026-10-01T10:00:00.000Z',
  type: 'expense', amountMinor: -1999, currencyKey: 'eur', originalAmountMinor: -2100, originalCurrencyKey: 'uah', tagId: null,
  planType: null, comment: null, transferId: null, dedupeHash: null, deletedAt: null, isOpening: false, raw: { a: [1] },
  createdBy: null, createdAt: '2026-11-01T00:00:00.000Z', updatedAt: '2026-11-01T00:00:00.000Z',
}

describe('слой Supabase: преобразование колонок', () => {
  it('деньги при записи уходят строкой с нужным числом знаков, без float', () => {
    const r = toRow('transactions', base, env)
    expect(r['amount']).toBe('-19.99')
    expect(r['original_amount']).toBe('-21.00')
    expect(toRow('transactions', { ...base, amountMinor: -5, currencyKey: 'jpy' }, env)['amount']).toBe('-5')
    expect(toRow('transactions', { ...base, amountMinor: 1234, currencyKey: 'kwd' }, env)['amount']).toBe('1.234')
  })
  it('деньги при чтении: JSON-число превращается в целые минорные единицы', () => {
    expect(numericToMinor(1245.58, 2)).toBe(124558)
    expect(numericToMinor(-0.07, 2)).toBe(-7)
    expect(numericToMinor(0.29, 2)).toBe(29)          // 0.29*100 = 28.999999999999996 в double
    expect(numericToMinor(5, 0)).toBe(5)
    expect(() => numericToMinor(1e20, 2)).toThrow(/STORAGE/)
  })
  it('сумма контрольной точки берёт валюту счёта', () => {
    const cp = { id: 'c', accountId: 'acc-jpy', asOf: '2026-10-01T00:00:00.000Z', balanceMinor: 500, kind: 'balance' as const, source: 'manual' as const, status: 'active' as const, note: null, createdBy: null, createdAt: '2026-11-01T00:00:00.000Z' }
    expect(toRow('checkpoints', cp, env)['balance']).toBe('500')
    expect(fromRow('checkpoints', { ...toRow('checkpoints', cp, env), balance: 500 }, env).balanceMinor).toBe(500)
  })
  it('операция проходит туда и обратно (как ответ PostgREST)', () => {
    const row = { ...toRow('transactions', base, env), amount: -19.99, original_amount: -21, booked_at: '2026-10-01T10:00:00+00:00', deleted_at: null, created_at: '2026-11-01T00:00:00+00:00', updated_at: '2026-11-01T00:00:00+00:00' }
    expect(fromRow('transactions', row, env)).toEqual(base)
  })
  it('время нормализуется к ISO UTC с Z', () => {
    const t = fromRow('transactions', { ...toRow('transactions', base, env), amount: -19.99, original_amount: null, original_currency_key: null, booked_at: '2026-10-01T12:00:00.123456+02:00', created_at: '2026-11-01T00:00:00+00:00', updated_at: '2026-11-01T00:00:00+00:00' }, env)
    expect(t.bookedAt).toBe('2026-10-01T10:00:00.123Z')
    expect(t.originalAmountMinor).toBeNull()
  })
  it('bytea: hex-хэш и base64-шифртекст туда и обратно', () => {
    const hash = 'ab01ff'.padEnd(64, '0')
    const enc = btoa(String.fromCharCode(1, 2, 3, 250))
    const ident = { id: 'i', accountId: 'a', kind: 'account_number' as const, valueHash: hash, valueEnc: enc, last4: '0255', validFrom: '2000-01-01', validTo: null }
    const row = toRow('accountIdentifiers', ident, env)
    expect(row['value_hash']).toBe('\\x' + hash)
    expect(row['value_enc']).toBe('\\x010203fa')
    expect(fromRow('accountIdentifiers', row, env)).toEqual(ident)
    expect([...pgHexToBytes(bytesToPgHex(Uint8Array.from([0, 255, 16])))]).toEqual([0, 255, 16])
    expect(() => pgHexToBytes('\\xzz')).toThrow()
  })
  it('курс: строка из 8 знаков; процент услуги без лишних нулей', () => {
    const r = { id: 'r', rateDate: '2026-10-01', baseCurrencyKey: 'eur', quoteCurrencyKey: 'uah', rate: '48.12345678', source: 'manual' }
    expect(toRow('fxRates', r, env)['rate']).toBe('48.12345678')
    expect(fromRow('fxRates', { ...toRow('fxRates', r, env), rate: 48.12345678 }, env).rate).toBe('48.12345678')
    expect(fromRow('fxRates', { ...toRow('fxRates', r, env), rate: 1.085 }, env).rate).toBe('1.08500000')
    const acc = fromRow('accounts', { id: 'a', key: 'k', name: 'n', type: 'firm', institution_id: null, project_id: 'p', holder: null, currency_key: 'uah', country_key: 'ua', timezone: null, tracking_mode: 'balance_and_movements', service_percent: -15, appearance: {}, sort_order: 0, archived_at: null }, env)
    expect(acc.servicePercent).toBe('-15')
  })
  it('журнал: id опускается при записи, возвращается числом', () => {
    const w = auditToRow({ at: '2026-11-01T00:00:00.000Z', userId: 'u', action: 'x', tableName: null, recordId: null, oldData: null, newData: null, details: { n: 1 } })
    expect('id' in w).toBe(false)
    expect(auditFromRow({ id: '7', at: '2026-11-01T00:00:00+00:00', user_id: 'u', action: 'x', table_name: null, record_id: null, old_data: null, new_data: null, details: { n: 1 } }).id).toBe(7)
  })
  it('спецификации покрывают все сущности и порядок записи', () => {
    expect(Object.keys(SPECS).sort()).toEqual([...ENTITY_NAMES].sort())
    expect([...WRITE_ORDER].sort()).toEqual([...ENTITY_NAMES].sort())
  })
})
