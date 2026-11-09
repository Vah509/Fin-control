// Счета: проверки при создании и изменении, архив. Данные справочников задаёт seed-загрузчик/настройки.
import type { Account } from '../data/types'
import { auditEntry } from './audit'
import type { CoreContext } from './context'
import { fail } from './errors'
import { isValidTimeZone } from './time'

export type NewAccountInput = Omit<Account, 'id' | 'archivedAt' | 'appearance' | 'sortOrder' | 'timezone' | 'servicePercent' | 'institutionId' | 'holder'> &
  Partial<Pick<Account, 'id' | 'appearance' | 'sortOrder' | 'timezone' | 'servicePercent' | 'institutionId' | 'holder'>>

const TYPES = ['bank', 'wallet', 'broker', 'cash', 'person', 'firm']
const MODES = ['balance_only', 'balance_and_movements']

async function validateAccount(ctx: CoreContext, a: Account) {
  if (!/^[a-z0-9_-]+$/.test(a.key)) fail('INVALID_FIELD', `ключ счёта: только a-z, 0-9, _ и -: ${a.key}`)
  if (!a.name.trim()) fail('INVALID_FIELD', 'нужно название счёта')
  if (!TYPES.includes(a.type)) fail('INVALID_FIELD', `тип счёта: ${a.type}`)
  if (!MODES.includes(a.trackingMode)) fail('INVALID_FIELD', `режим учёта: ${a.trackingMode}`)
  if (a.timezone !== null && !isValidTimeZone(a.timezone)) fail('INVALID_TIMEZONE', `пояс счёта: ${a.timezone}`)
  if (a.servicePercent !== null) {
    const p = Number(a.servicePercent)
    if (!/^-?\d+(\.\d+)?$/.test(a.servicePercent) || p < -100 || p > 100) fail('INVALID_FIELD', 'процент услуги от -100 до 100')
  }
  const [cur, cou, pro, ins] = await Promise.all([
    ctx.storage.list('currencies'), ctx.storage.list('countries'), ctx.storage.list('projects'), ctx.storage.list('institutions'),
  ])
  if (!cur.some((c) => c.key === a.currencyKey)) fail('NOT_FOUND', `валюта ${a.currencyKey}`)
  if (!cou.some((c) => c.key === a.countryKey)) fail('NOT_FOUND', `страна ${a.countryKey}`)
  if (!pro.some((p) => p.id === a.projectId)) fail('NOT_FOUND', 'проект не найден')
  if (a.institutionId && !ins.some((i) => i.id === a.institutionId)) fail('NOT_FOUND', 'учреждение не найдено')
}

export async function createAccount(ctx: CoreContext, input: NewAccountInput): Promise<Account> {
  const all = await ctx.storage.list('accounts')
  if (all.some((a) => a.key === input.key)) fail('DUPLICATE_KEY', `счёт с ключом ${input.key} уже есть`)
  const acc: Account = {
    id: input.id ?? ctx.newId(), key: input.key, name: input.name, type: input.type,
    institutionId: input.institutionId ?? null, projectId: input.projectId, holder: input.holder ?? null,
    currencyKey: input.currencyKey, countryKey: input.countryKey, timezone: input.timezone ?? null,
    trackingMode: input.trackingMode, servicePercent: input.servicePercent ?? null,
    appearance: input.appearance ?? {}, sortOrder: input.sortOrder ?? 0, archivedAt: null,
  }
  await validateAccount(ctx, acc)
  await ctx.storage.applyBatch({
    put: { accounts: [acc] },
    audit: [auditEntry(ctx, 'account_created', { tableName: 'accounts', recordId: acc.id, newData: acc as never })],
  })
  return acc
}

export type AccountPatch = Partial<Omit<Account, 'id' | 'archivedAt'>>

export async function updateAccount(ctx: CoreContext, id: string, patch: AccountPatch): Promise<Account> {
  const all = await ctx.storage.list('accounts')
  const old = all.find((a) => a.id === id) ?? fail('NOT_FOUND', `счёт ${id} не найден`)
  const next: Account = { ...old, ...patch }
  if (next.key !== old.key && all.some((a) => a.key === next.key)) fail('DUPLICATE_KEY', `ключ ${next.key} занят`)
  if (next.currencyKey !== old.currencyKey) {
    const any = await ctx.storage.listTransactions({ accountId: id, includeDeleted: true })
    if (any.length) fail('CURRENCY_LOCKED', 'валюту счёта с операциями менять нельзя')
  }
  await validateAccount(ctx, next)
  await ctx.storage.applyBatch({
    put: { accounts: [next] },
    audit: [auditEntry(ctx, 'account_updated', { tableName: 'accounts', recordId: id, oldData: old as never, newData: next as never })],
  })
  return next
}

/** Архив вместо удаления: прошлые срезы не меняются. */
export async function setAccountArchived(ctx: CoreContext, id: string, archived: boolean): Promise<Account> {
  const old = (await ctx.storage.list('accounts')).find((a) => a.id === id) ?? fail('NOT_FOUND', `счёт ${id} не найден`)
  const next: Account = { ...old, archivedAt: archived ? (old.archivedAt ?? ctx.now().toISOString()) : null }
  await ctx.storage.applyBatch({
    put: { accounts: [next] },
    audit: [auditEntry(ctx, archived ? 'account_archived' : 'account_unarchived', { tableName: 'accounts', recordId: id, oldData: old as never, newData: next as never })],
  })
  return next
}
