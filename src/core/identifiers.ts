// Признаки счетов: нормализация, HMAC для поиска, шифрование значения, непересечение сроков.
// В базе только хэш, шифртекст и last4. Полный номер видит только владелец, просмотр пишется в журнал.
import type { AccountIdentifier, IdentifierKind } from '../data/types'
import { auditEntry } from './audit'
import type { CoreContext } from './context'
import type { FieldCrypto } from './crypto'
import { fail } from './errors'
import { addDays, assertDate } from './time'

/** Пробелы и регистр не важны; для названий в выписке пробелы схлопываются в один. */
export function normalizeIdentifier(kind: IdentifierKind, value: string): string {
  const v = value.normalize('NFKC').trim()
  const n = kind === 'statement_name' ? v.replace(/\s+/g, ' ') : v.replace(/\s+/g, '')
  return n.toLowerCase()
}

const last4Of = (n: string) => {
  const s = n.replace(/[^a-z0-9]/g, '')
  return s.length >= 4 ? s.slice(-4) : s || null
}
const needCrypto = (ctx: CoreContext): FieldCrypto => ctx.crypto ?? fail('CRYPTO_UNAVAILABLE', 'ключи шифрования не загружены')
const hashOf = (c: FieldCrypto, kind: IdentifierKind, normalized: string) => c.hmacHex(`${kind}:${normalized}`)

const overlaps = (a: { validFrom: string; validTo: string | null }, b: { validFrom: string; validTo: string | null }) =>
  a.validFrom <= (b.validTo ?? '9999-12-31') && b.validFrom <= (a.validTo ?? '9999-12-31')

export interface AddIdentifierInput {
  accountId: string; kind: IdentifierKind; value: string
  validFrom?: string
  /** Замена: старый признак закрывается днём раньше validFrom. */
  replacesId?: string
}

export async function addAccountIdentifier(ctx: CoreContext, input: AddIdentifierInput): Promise<AccountIdentifier> {
  const c = needCrypto(ctx)
  const accounts = await ctx.storage.list('accounts')
  if (!accounts.some((a) => a.id === input.accountId)) fail('NOT_FOUND', 'счёт не найден')
  const norm = normalizeIdentifier(input.kind, input.value)
  if (!norm) fail('INVALID_FIELD', 'пустой признак')
  const validFrom = assertDate(input.validFrom ?? ctx.now().toISOString().slice(0, 10), 'начало действия')

  const hash = await hashOf(c, input.kind, norm)
  let existing = await ctx.storage.listAccountIdentifiers({ valueHash: hash })
  const put: AccountIdentifier[] = []

  if (input.replacesId) {
    const old = (await ctx.storage.listAccountIdentifiers({ accountId: input.accountId })).find((i) => i.id === input.replacesId)
    if (!old) return fail('NOT_FOUND', 'заменяемый признак не найден')
    const closeAt = addDays(validFrom, -1)
    if (closeAt < old.validFrom) fail('IDENTIFIER_INVALID_RANGE', 'новый признак должен начинаться позже старого')
    const closed = { ...old, validTo: closeAt }
    put.push(closed)
    existing = existing.map((i) => (i.id === old.id ? closed : i))
  }
  const candidate = { validFrom, validTo: null }
  const clash = existing.find((i) => overlaps(i, candidate))
  if (clash) fail('IDENTIFIER_OVERLAP', 'такой признак уже действует (на этом или другом счёте)', { accountId: clash.accountId })

  const row: AccountIdentifier = {
    id: ctx.newId(), accountId: input.accountId, kind: input.kind, valueHash: hash,
    valueEnc: await c.encrypt(norm), last4: last4Of(norm), validFrom, validTo: null,
  }
  put.push(row)
  await ctx.storage.applyBatch({
    put: { accountIdentifiers: put },
    audit: [auditEntry(ctx, input.replacesId ? 'identifier_replaced' : 'identifier_added', {
      tableName: 'account_identifiers', recordId: row.id,
      details: { accountId: input.accountId, kind: input.kind, last4: row.last4, validFrom, replacesId: input.replacesId ?? null },
    })],
  })
  return row
}

/** Поиск счёта по признаку на дату (дата выписки). */
export async function findAccountByIdentifier(ctx: CoreContext, kind: IdentifierKind, value: string, date: string): Promise<string | null> {
  const c = needCrypto(ctx)
  assertDate(date)
  const hash = await hashOf(c, kind, normalizeIdentifier(kind, value))
  const hit = (await ctx.storage.listAccountIdentifiers({ valueHash: hash }))
    .find((i) => i.validFrom <= date && date <= (i.validTo ?? '9999-12-31'))
  return hit?.accountId ?? null
}

/** Полное значение (в нормализованном виде). Только владелец; пишется в журнал. */
export async function revealAccountIdentifier(ctx: CoreContext, id: string): Promise<string> {
  if (!ctx.actor.isOwner) fail('FORBIDDEN', 'полный номер может смотреть только владелец')
  const c = needCrypto(ctx)
  const row = (await ctx.storage.listAccountIdentifiers()).find((i) => i.id === id) ?? fail('NOT_FOUND', 'признак не найден')
  const plain = await c.decrypt(row.valueEnc)
  await ctx.storage.applyBatch({
    audit: [auditEntry(ctx, 'identifier_revealed', { tableName: 'account_identifiers', recordId: id, details: { accountId: row.accountId } })],
  })
  return plain
}

/**
 * Признак «номер счёта» по последним 4 цифрам, без ключей шифрования (решение владельца 22.11.2026: в приложении ключей нет).
 * Хэш считается SHA-256 от «last4:account_number:цифры:id счёта» (уникален для счёта), в шифр-поле лежит те же 4 цифры (base64, не секрет).
 * Полного номера нет, поэтому просмотр номера и поиск по полному номеру для такого признака не работают.
 */
export async function addAccountLast4(ctx: CoreContext, accountId: string, last4: string, validFrom?: string): Promise<AccountIdentifier> {
  if (!ctx.actor.isOwner) fail('FORBIDDEN', 'признаки добавляет только владелец')
  if (!/^[A-Za-z0-9]{4}$/.test(last4)) fail('INVALID_FIELD', 'нужны ровно 4 последние цифры номера')
  const acc = (await ctx.storage.list('accounts')).find((a) => a.id === accountId) ?? fail('NOT_FOUND', 'счёт не найден')
  const from = assertDate(validFrom ?? '1970-01-01', 'начало действия')
  const norm = last4.toLowerCase()
  const dup = (await ctx.storage.listAccountIdentifiers({ accountId })).find((i) => i.kind === 'account_number' && i.last4 === norm && !i.validTo)
  if (dup) fail('IDENTIFIER_OVERLAP', 'такой признак у счёта уже есть')
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(`last4:account_number:${norm}:${acc.id}`)))
  const row: AccountIdentifier = {
    id: ctx.newId(), accountId, kind: 'account_number', valueHash: [...digest].map((b) => b.toString(16).padStart(2, '0')).join(''),
    valueEnc: btoa(norm), last4: norm, validFrom: from, validTo: null,
  }
  await ctx.storage.applyBatch({
    put: { accountIdentifiers: [row] },
    audit: [auditEntry(ctx, 'identifier_added', { tableName: 'account_identifiers', recordId: row.id, details: { accountId, kind: 'account_number', last4: norm, validFrom: from, withoutCrypto: true } })],
  })
  return row
}
