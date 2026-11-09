// Операции: проверки и запись. Удаление = пометка deleted_at (жёсткое удаление только при закрытии периода).
import type { Account, Transaction, TransactionSource, TransactionType } from '../data/types'
import { auditEntry, txForAudit } from './audit'
import type { CoreContext } from './context'
import { fail } from './errors'
import { assertMinor } from './money'
import { assertUnlocked } from './locks'
import { normalizeIso } from './time'

export interface NewTransactionInput {
  id?: string
  accountId: string
  counterpartyId?: string | null
  importId?: string | null
  source?: TransactionSource
  bookedAt: string
  type: TransactionType
  amountMinor: number
  currencyKey?: string
  originalAmountMinor?: number | null
  originalCurrencyKey?: string | null
  tagId?: string | null
  planType?: string | null
  comment?: string | null
  transferId?: string | null
  dedupeHash?: string | null
  isOpening?: boolean
  raw?: Transaction['raw']
}

/** Чистые проверки формы операции (без обращения к хранилищу). */
export function checkTransactionShape(t: Transaction, account: Account): void {
  assertMinor(t.amountMinor)
  if (t.amountMinor === 0) fail('INVALID_AMOUNT', 'сумма не может быть нулём')
  if (t.type === 'income' && t.amountMinor <= 0) fail('INVALID_SIGN', 'приход должен быть больше нуля')
  if ((t.type === 'expense' || t.type === 'fee') && t.amountMinor >= 0) fail('INVALID_SIGN', 'расход и комиссия должны быть меньше нуля')
  if (t.currencyKey !== account.currencyKey) {
    fail('CURRENCY_MISMATCH', `валюта операции ${t.currencyKey}, валюта счёта ${account.currencyKey}`)
  }
  if ((t.originalAmountMinor === null) !== (t.originalCurrencyKey === null)) {
    fail('INVALID_ORIGINAL', 'исходные сумма и валюта задаются вместе')
  }
  if (t.originalAmountMinor !== null) {
    assertMinor(t.originalAmountMinor, 'исходная сумма')
    if (t.originalAmountMinor === 0 || Math.sign(t.originalAmountMinor) !== Math.sign(t.amountMinor)) {
      fail('INVALID_ORIGINAL', 'исходная сумма ненулевая и с тем же знаком')
    }
  }
  if (t.isOpening && t.type !== 'adjustment') fail('OPENING_NOT_ADJUSTMENT', 'начальная запись должна быть корректировкой')
}

async function loadAccount(ctx: CoreContext, id: string): Promise<Account> {
  return (await ctx.storage.list('accounts')).find((a) => a.id === id) ?? fail('NOT_FOUND', `счёт ${id} не найден`)
}

async function checkPlanType(ctx: CoreContext, planType: string | null) {
  if (planType === null) return
  const known = await ctx.storage.list('planTypes')
  if (!known.some((p) => p.key === planType)) fail('INVALID_FIELD', `неизвестная плановость: ${planType}`)
}

async function assertNoOtherOpening(ctx: CoreContext, accountId: string, exceptId: string) {
  const open = await ctx.storage.listTransactions({ accountId, isOpening: true })
  if (open.some((t) => t.id !== exceptId)) fail('OPENING_EXISTS', 'у счёта уже есть начальная корректировка')
}

/** Собирает и проверяет новую операцию, не записывая её (для общего пакета). */
export async function buildTransaction(ctx: CoreContext, input: NewTransactionInput, account?: Account): Promise<Transaction> {
  const acc = account ?? (await loadAccount(ctx, input.accountId))
  if (acc.archivedAt) fail('ACCOUNT_ARCHIVED', 'архивный счёт не принимает операции')
  const now = ctx.now().toISOString()
  const t: Transaction = {
    id: input.id ?? ctx.newId(), accountId: acc.id,
    counterpartyId: input.counterpartyId ?? null, importId: input.importId ?? null,
    source: input.source ?? 'manual', bookedAt: normalizeIso(input.bookedAt, 'дата операции'),
    type: input.type, amountMinor: input.amountMinor, currencyKey: input.currencyKey ?? acc.currencyKey,
    originalAmountMinor: input.originalAmountMinor ?? null, originalCurrencyKey: input.originalCurrencyKey ?? null,
    tagId: input.tagId ?? null, planType: input.planType ?? null, comment: input.comment ?? null,
    transferId: input.transferId ?? null, dedupeHash: input.dedupeHash ?? null, deletedAt: null,
    isOpening: input.isOpening ?? false, raw: input.raw ?? null,
    createdBy: ctx.actor.userId, createdAt: now, updatedAt: now,
  }
  checkTransactionShape(t, acc)
  await checkPlanType(ctx, t.planType)
  if (t.isOpening) await assertNoOtherOpening(ctx, acc.id, t.id)
  await assertUnlocked(ctx, acc, t.bookedAt)
  return t
}

const isAudited = (t: Transaction) => t.type === 'adjustment'

export function transactionAudit(ctx: CoreContext, action: string, t: Transaction, old?: Transaction) {
  return auditEntry(ctx, action, {
    tableName: 'transactions', recordId: t.id,
    oldData: old ? txForAudit(old) : null, newData: txForAudit(t),
  })
}

export async function createTransaction(ctx: CoreContext, input: NewTransactionInput): Promise<Transaction> {
  const t = await buildTransaction(ctx, input)
  await ctx.storage.applyBatch({
    put: { transactions: [t] },
    audit: isAudited(t) ? [transactionAudit(ctx, t.isOpening ? 'opening_created' : 'adjustment_created', t)] : [],
  })
  return t
}

export type TransactionPatch = Partial<Pick<NewTransactionInput,
  'counterpartyId' | 'tagId' | 'planType' | 'comment' | 'bookedAt' | 'type' | 'amountMinor' |
  'originalAmountMinor' | 'originalCurrencyKey'>>

export async function updateTransaction(ctx: CoreContext, id: string, patch: TransactionPatch): Promise<Transaction> {
  const old = (await ctx.storage.getTransaction(id)) ?? fail('NOT_FOUND', `операция ${id} не найдена`)
  if (old.deletedAt) fail('NOT_FOUND', 'операция помечена на удаление; сначала восстановите')
  const acc = await loadAccount(ctx, old.accountId)
  await assertUnlocked(ctx, acc, old.bookedAt)
  const next: Transaction = {
    ...old,
    counterpartyId: patch.counterpartyId !== undefined ? patch.counterpartyId : old.counterpartyId,
    tagId: patch.tagId !== undefined ? patch.tagId : old.tagId,
    planType: patch.planType !== undefined ? patch.planType : old.planType,
    comment: patch.comment !== undefined ? patch.comment : old.comment,
    bookedAt: patch.bookedAt !== undefined ? normalizeIso(patch.bookedAt, 'дата операции') : old.bookedAt,
    type: patch.type ?? old.type,
    amountMinor: patch.amountMinor ?? old.amountMinor,
    originalAmountMinor: patch.originalAmountMinor !== undefined ? patch.originalAmountMinor : old.originalAmountMinor,
    originalCurrencyKey: patch.originalCurrencyKey !== undefined ? patch.originalCurrencyKey : old.originalCurrencyKey,
    updatedAt: ctx.now().toISOString(),
  }
  checkTransactionShape(next, acc)
  await checkPlanType(ctx, next.planType)
  await assertUnlocked(ctx, acc, next.bookedAt)
  await ctx.storage.applyBatch({
    put: { transactions: [next] },
    audit: isAudited(old) || isAudited(next) ? [transactionAudit(ctx, 'transaction_updated', next, old)] : [],
  })
  return next
}

export async function softDeleteTransaction(ctx: CoreContext, id: string): Promise<Transaction> {
  const old = (await ctx.storage.getTransaction(id)) ?? fail('NOT_FOUND', `операция ${id} не найдена`)
  if (old.deletedAt) return old
  const acc = await loadAccount(ctx, old.accountId)
  await assertUnlocked(ctx, acc, old.bookedAt)
  const next = { ...old, deletedAt: ctx.now().toISOString(), updatedAt: ctx.now().toISOString() }
  await ctx.storage.applyBatch({
    put: { transactions: [next] },
    audit: isAudited(old) ? [transactionAudit(ctx, 'transaction_deleted', next, old)] : [],
  })
  return next
}

export async function restoreTransaction(ctx: CoreContext, id: string): Promise<Transaction> {
  const old = (await ctx.storage.getTransaction(id)) ?? fail('NOT_FOUND', `операция ${id} не найдена`)
  if (!old.deletedAt) return old
  const acc = await loadAccount(ctx, old.accountId)
  await assertUnlocked(ctx, acc, old.bookedAt)
  if (old.isOpening) await assertNoOtherOpening(ctx, acc.id, old.id)
  const next = { ...old, deletedAt: null, updatedAt: ctx.now().toISOString() }
  await ctx.storage.applyBatch({
    put: { transactions: [next] },
    audit: isAudited(old) ? [transactionAudit(ctx, 'transaction_restored', next, old)] : [],
  })
  return next
}
