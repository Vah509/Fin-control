// Соответствие сущностей ядра (camelCase, минорные единицы) таблицам Supabase (snake_case, numeric).
// Только преобразование формы данных. Никаких правил.
import { formatMinor } from '../../core/money'
import type { AuditEntry, EntityMap, EntityName, NewAuditEntry } from '../types'

type Kind =
  | 'str' | 'int' | 'bool' | 'json'
  | 'ts'      // timestamptz: наружу всегда ISO UTC с Z и миллисекундами
  | 'rate'    // numeric(18,8) -> строка из 8 знаков
  | 'dec'     // numeric без привязки к валюте (service_percent) -> строка без лишних нулей
  | 'hex'     // bytea, в ядре hex-строка
  | 'b64'     // bytea, в ядре base64-строка
  | { money: 'currencyKey' | 'originalCurrencyKey' | 'accountCurrency' }

interface Field { p: string; c: string; k: Kind }
interface Spec { table: string; pk: string; fields: Field[] }

const f = (p: string, c: string, k: Kind = 'str'): Field => ({ p, c, k })

export const SPECS: { [K in EntityName]: Spec } = {
  appSettings: { table: 'app_settings', pk: 'key', fields: [f('key', 'key'), f('value', 'value', 'json')] },
  planTypes: { table: 'plan_types', pk: 'key', fields: [f('key', 'key'), f('name', 'name'), f('sortOrder', 'sort_order', 'int')] },
  countries: { table: 'countries', pk: 'key', fields: [f('key', 'key'), f('name', 'name'), f('timezone', 'timezone')] },
  currencies: { table: 'currencies', pk: 'key', fields: [f('key', 'key'), f('code', 'code'), f('name', 'name'), f('decimals', 'decimals', 'int')] },
  institutions: { table: 'institutions', pk: 'id', fields: [
    f('id', 'id'), f('key', 'key'), f('name', 'name'), f('kind', 'kind'), f('countryKey', 'country_key'), f('appearance', 'appearance', 'json'),
  ] },
  projects: { table: 'projects', pk: 'id', fields: [f('id', 'id'), f('key', 'key'), f('name', 'name')] },
  accounts: { table: 'accounts', pk: 'id', fields: [
    f('id', 'id'), f('key', 'key'), f('name', 'name'), f('type', 'type'), f('institutionId', 'institution_id'),
    f('projectId', 'project_id'), f('holder', 'holder'), f('currencyKey', 'currency_key'), f('countryKey', 'country_key'),
    f('timezone', 'timezone'), f('trackingMode', 'tracking_mode'), f('servicePercent', 'service_percent', 'dec'),
    f('appearance', 'appearance', 'json'), f('sortOrder', 'sort_order', 'int'), f('archivedAt', 'archived_at', 'ts'),
  ] },
  accountIdentifiers: { table: 'account_identifiers', pk: 'id', fields: [
    f('id', 'id'), f('accountId', 'account_id'), f('kind', 'kind'), f('valueHash', 'value_hash', 'hex'),
    f('valueEnc', 'value_enc', 'b64'), f('last4', 'last4'), f('validFrom', 'valid_from'), f('validTo', 'valid_to'),
  ] },
  tagGroups: { table: 'tag_groups', pk: 'id', fields: [
    f('id', 'id'), f('key', 'key'), f('name', 'name'), f('isService', 'is_service', 'bool'), f('sortOrder', 'sort_order', 'int'),
  ] },
  tags: { table: 'tags', pk: 'id', fields: [
    f('id', 'id'), f('key', 'key'), f('groupId', 'group_id'), f('name', 'name'), f('sortOrder', 'sort_order', 'int'),
    f('archivedAt', 'archived_at', 'ts'),
  ] },
  counterparties: { table: 'counterparties', pk: 'id', fields: [
    f('id', 'id'), f('key', 'key'), f('name', 'name'), f('kind', 'kind'), f('accountId', 'account_id'),
    f('defaultTagId', 'default_tag_id'), f('defaultPlanType', 'default_plan_type'),
  ] },
  counterpartyIdentifiers: { table: 'counterparty_identifiers', pk: 'id', fields: [
    f('id', 'id'), f('counterpartyId', 'counterparty_id'), f('kind', 'kind'), f('value', 'value'),
    f('valueHash', 'value_hash', 'hex'), f('valueEnc', 'value_enc', 'b64'), f('last4', 'last4'),
    f('validFrom', 'valid_from'), f('validTo', 'valid_to'),
  ] },
  transactions: { table: 'transactions', pk: 'id', fields: [
    f('id', 'id'), f('accountId', 'account_id'), f('counterpartyId', 'counterparty_id'), f('importId', 'import_id'),
    f('source', 'source'), f('bookedAt', 'booked_at', 'ts'), f('type', 'type'),
    f('amountMinor', 'amount', { money: 'currencyKey' }), f('currencyKey', 'currency_key'),
    f('originalAmountMinor', 'original_amount', { money: 'originalCurrencyKey' }),
    f('originalCurrencyKey', 'original_currency_key'),
    f('tagId', 'tag_id'), f('planType', 'plan_type'), f('comment', 'comment'), f('transferId', 'transfer_id'),
    f('dedupeHash', 'dedupe_hash'), f('deletedAt', 'deleted_at', 'ts'), f('isOpening', 'is_opening', 'bool'),
    f('raw', 'raw', 'json'), f('createdBy', 'created_by'), f('createdAt', 'created_at', 'ts'), f('updatedAt', 'updated_at', 'ts'),
  ] },
  checkpoints: { table: 'balance_checkpoints', pk: 'id', fields: [
    f('id', 'id'), f('accountId', 'account_id'), f('asOf', 'as_of', 'ts'),
    f('balanceMinor', 'balance', { money: 'accountCurrency' }), f('kind', 'kind'), f('source', 'source'),
    f('status', 'status'), f('note', 'note'), f('createdBy', 'created_by'), f('createdAt', 'created_at', 'ts'),
  ] },
  periodLocks: { table: 'period_locks', pk: 'id', fields: [
    f('id', 'id'), f('seq', 'seq', 'int'), f('projectId', 'project_id'), f('lockedThrough', 'locked_through'),
    f('lockedAt', 'locked_at', 'ts'), f('lockedBy', 'locked_by'), f('status', 'status'),
    f('releasedAt', 'released_at', 'ts'), f('releasedBy', 'released_by'), f('releaseReason', 'release_reason'),
  ] },
  fxRates: { table: 'fx_rates', pk: 'id', fields: [
    f('id', 'id'), f('rateDate', 'rate_date'), f('baseCurrencyKey', 'base_currency_key'),
    f('quoteCurrencyKey', 'quote_currency_key'), f('rate', 'rate', 'rate'), f('source', 'source'),
  ] },
  fxSourcePriorities: { table: 'fx_source_priority', pk: 'source', fields: [f('source', 'source'), f('priority', 'priority', 'int')] },
}

/** Порядок записи в пакете: родители раньше детей (тот же порядок в SQL-функции apply_batch). */
export const WRITE_ORDER: EntityName[] = [
  'appSettings', 'planTypes', 'countries', 'currencies', 'institutions', 'projects', 'accounts', 'accountIdentifiers',
  'tagGroups', 'tags', 'counterparties', 'counterpartyIdentifiers', 'transactions', 'checkpoints', 'periodLocks',
  'fxRates', 'fxSourcePriorities',
]

/** Откуда брать число знаков валюты. Заполняется слоем хранения. */
export interface MoneyEnv {
  decimals(currencyKey: string): number
  accountCurrency(accountId: string): string
}

// ---------- примитивы ----------
const HEX = /^[0-9a-f]*$/i

export function bytesToPgHex(bytes: Uint8Array): string {
  let s = '\\x'
  for (const b of bytes) s += b.toString(16).padStart(2, '0')
  return s
}
export function pgHexToBytes(v: string): Uint8Array {
  const h = v.startsWith('\\x') ? v.slice(2) : v
  if (h.length % 2 !== 0 || !HEX.test(h)) throw new Error('STORAGE: некорректное bytea')
  const out = new Uint8Array(h.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16)
  return out
}
const b64ToBytes = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0))
const bytesToB64 = (u: Uint8Array) => { let s = ''; for (const b of u) s += String.fromCharCode(b); return btoa(s) }

/** numeric из PostgREST приходит JSON-числом. Переводим в целые минорные единицы. */
export function numericToMinor(v: number | string, decimals: number): number {
  const m = Math.round(Number(v) * 10 ** decimals)
  if (!Number.isSafeInteger(m)) throw new Error(`STORAGE: сумма вне допустимого диапазона: ${v}`)
  return m
}

/** Курс numeric(18,8) -> строка с 8 знаками. Точность double (около 15 значащих цифр) для курсов достаточна. */
export function numericToRate(v: number | string): string {
  return Number(v).toFixed(8)
}

const nullish = (v: unknown) => v === null || v === undefined

function encode(k: Kind, v: unknown, obj: Record<string, unknown>, env: MoneyEnv): unknown {
  if (nullish(v)) return null
  if (typeof k === 'object') {
    const cur = k.money === 'accountCurrency' ? env.accountCurrency(obj['accountId'] as string) : (obj[k.money] as string)
    return formatMinor(v as number, env.decimals(cur))   // строкой: без float при записи
  }
  switch (k) {
    case 'hex': return '\\x' + (v as string)
    case 'b64': return bytesToPgHex(b64ToBytes(v as string))
    default: return v
  }
}

function decode(k: Kind, v: unknown, row: Record<string, unknown>, env: MoneyEnv): unknown {
  if (nullish(v)) return null
  if (typeof k === 'object') {
    const cur = k.money === 'accountCurrency'
      ? env.accountCurrency(row['account_id'] as string)
      : (row[k.money === 'currencyKey' ? 'currency_key' : 'original_currency_key'] as string)
    return numericToMinor(v as number, env.decimals(cur))
  }
  switch (k) {
    case 'ts': return new Date(v as string).toISOString()
    case 'rate': return numericToRate(v as number | string)
    case 'dec': return String(Number(v))
    case 'hex': return [...pgHexToBytes(v as string)].map((b) => b.toString(16).padStart(2, '0')).join('')
    case 'b64': return bytesToB64(pgHexToBytes(v as string))
    default: return v
  }
}

export function toRow<K extends EntityName>(entity: K, obj: EntityMap[K], env: MoneyEnv): Record<string, unknown> {
  const spec = SPECS[entity]
  const o = obj as unknown as Record<string, unknown>
  const out: Record<string, unknown> = {}
  for (const fd of spec.fields) out[fd.c] = encode(fd.k, o[fd.p], o, env)
  return out
}

export function fromRow<K extends EntityName>(entity: K, row: Record<string, unknown>, env: MoneyEnv): EntityMap[K] {
  const spec = SPECS[entity]
  const out: Record<string, unknown> = {}
  for (const fd of spec.fields) out[fd.p] = decode(fd.k, row[fd.c], row, env)
  return out as unknown as EntityMap[K]
}

// ---------- журнал ----------
export function auditToRow(a: NewAuditEntry): Record<string, unknown> {
  return {
    at: a.at, user_id: a.userId, action: a.action, table_name: a.tableName, record_id: a.recordId,
    old_data: a.oldData, new_data: a.newData, details: a.details,
  }
}
export function auditFromRow(r: Record<string, unknown>): AuditEntry {
  return {
    id: Number(r['id']), at: new Date(r['at'] as string).toISOString(), userId: (r['user_id'] as string | null) ?? null,
    action: r['action'] as string, tableName: (r['table_name'] as string | null) ?? null,
    recordId: (r['record_id'] as string | null) ?? null, oldData: (r['old_data'] ?? null) as AuditEntry['oldData'],
    newData: (r['new_data'] ?? null) as AuditEntry['newData'], details: (r['details'] ?? null) as AuditEntry['details'],
  }
}
