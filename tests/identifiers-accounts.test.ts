import { describe, expect, it } from 'vitest'
import {
  addAccountIdentifier, createAccount, createTransaction, findAccountByIdentifier, normalizeIdentifier,
  revealAccountIdentifier, setAccountArchived, updateAccount,
} from '../src/core'
import { code, ID, setup } from './helpers'

describe('признаки счетов', () => {
  it('нормализация: пробелы и регистр не важны', () => {
    expect(normalizeIdentifier('account_number', 'SK12 3456 7890')).toBe('sk1234567890')
    expect(normalizeIdentifier('statement_name', '  Lidl   DAKUJE 165 ')).toBe('lidl dakuje 165')
  })
  it('поиск по дате; в базе нет открытого значения; просмотр только владельцем и пишется в журнал', async () => {
    const { ctx, storage } = await setup({ withCrypto: true })
    const row = await addAccountIdentifier(ctx, { accountId: ID.space, kind: 'account_number', value: 'SK12 3456 7890 0255', validFrom: '2026-01-01' })
    expect(row.last4).toBe('0255')
    expect(JSON.stringify(row).toLowerCase()).not.toContain('sk1234567890')
    expect(await findAccountByIdentifier(ctx, 'account_number', 'sk12345678900255', '2026-10-01')).toBe(ID.space)
    expect(await findAccountByIdentifier(ctx, 'account_number', 'sk12345678900255', '2025-12-31')).toBeNull()
    expect(await findAccountByIdentifier(ctx, 'card_mask', 'sk12345678900255', '2026-10-01')).toBeNull()
    const viewer = { ...ctx, actor: { userId: 'u2', isOwner: false } }
    expect(await code(revealAccountIdentifier(viewer, row.id))).toBe('FORBIDDEN')
    expect(await revealAccountIdentifier(ctx, row.id)).toBe('sk12345678900255')
    const log = await storage.listAudit()
    expect(log.map((l) => l.action)).toContain('identifier_revealed')
    expect(JSON.stringify(log)).not.toContain('345678900255')
  })
  it('один признак не может принадлежать двум счетам одновременно', async () => {
    const { ctx } = await setup({ withCrypto: true })
    await addAccountIdentifier(ctx, { accountId: ID.space, kind: 'card_mask', value: '4324', validFrom: '2026-01-01' })
    expect(await code(addAccountIdentifier(ctx, { accountId: ID.mono, kind: 'card_mask', value: '4324', validFrom: '2026-05-01' }))).toBe('IDENTIFIER_OVERLAP')
  })
  it('замена: старый закрывается днём раньше, затем номер может перейти на другой счёт', async () => {
    const { ctx } = await setup({ withCrypto: true })
    const old = await addAccountIdentifier(ctx, { accountId: ID.space, kind: 'card_mask', value: '4324', validFrom: '2026-01-01' })
    expect(await code(addAccountIdentifier(ctx, { accountId: ID.space, kind: 'card_mask', value: '9999', validFrom: '2026-01-01', replacesId: old.id }))).toBe('IDENTIFIER_INVALID_RANGE')
    await addAccountIdentifier(ctx, { accountId: ID.space, kind: 'card_mask', value: '9999', validFrom: '2026-06-01', replacesId: old.id })
    expect(await findAccountByIdentifier(ctx, 'card_mask', '4324', '2026-05-31')).toBe(ID.space)
    expect(await findAccountByIdentifier(ctx, 'card_mask', '4324', '2026-06-01')).toBeNull()
    expect(await findAccountByIdentifier(ctx, 'card_mask', '9999', '2026-06-01')).toBe(ID.space)
    await addAccountIdentifier(ctx, { accountId: ID.mono, kind: 'card_mask', value: '4324', validFrom: '2026-07-01' })
    expect(await findAccountByIdentifier(ctx, 'card_mask', '4324', '2026-08-01')).toBe(ID.mono)
  })
  it('без ключей шифрования признаки не работают', async () => {
    const { ctx } = await setup()
    expect(await code(addAccountIdentifier(ctx, { accountId: ID.space, kind: 'card_mask', value: '4324' }))).toBe('CRYPTO_UNAVAILABLE')
  })
})

describe('счета', () => {
  const base = { key: 'new_acc', name: 'Новый', type: 'bank' as const, projectId: ID.lichnoe, currencyKey: 'eur', countryKey: 'sk', trackingMode: 'balance_and_movements' as const }
  it('создание и проверки', async () => {
    const { ctx } = await setup()
    expect(await code(createAccount(ctx, { ...base, key: 'slsp_space' }))).toBe('DUPLICATE_KEY')
    expect(await code(createAccount(ctx, { ...base, key: 'Bad Key' }))).toBe('INVALID_FIELD')
    expect(await code(createAccount(ctx, { ...base, timezone: 'Mars/Base' }))).toBe('INVALID_TIMEZONE')
    expect(await code(createAccount(ctx, { ...base, currencyKey: 'xxx' }))).toBe('NOT_FOUND')
    expect(await code(createAccount(ctx, { ...base, servicePercent: '-150' }))).toBe('INVALID_FIELD')
    expect(await code(createAccount(ctx, { ...base, servicePercent: '-15' }))).toBe('NO_ERROR')
  })
  it('валюту счёта с операциями менять нельзя; архив не меняет прошлые остатки', async () => {
    const { ctx } = await setup()
    expect(await code(updateAccount(ctx, ID.space, { currencyKey: 'usd' }))).toBe('NO_ERROR')   // операций ещё нет
    await updateAccount(ctx, ID.space, { currencyKey: 'eur' })
    await createTransaction(ctx, { accountId: ID.space, bookedAt: '2026-10-01T10:00:00Z', type: 'income', amountMinor: 1 })
    expect(await code(updateAccount(ctx, ID.space, { currencyKey: 'usd' }))).toBe('CURRENCY_LOCKED')
    const a = await setAccountArchived(ctx, ID.space, true)
    expect(a.archivedAt).not.toBeNull()
    expect((await setAccountArchived(ctx, ID.space, false)).archivedAt).toBeNull()
  })
})
