// Форма ввода остатка: предпросмотр и запись. Одним пакетом: корректировка (если нужна) + контрольная точка.
import type { BalanceCheckpoint, Transaction } from '../data/types'
import { auditEntry } from './audit'
import { balanceAt } from './balance'
import { buildCheckpoint } from './checkpoints'
import type { CoreContext } from './context'
import { fail } from './errors'
import { assertMinor } from './money'
import { buildTransaction, transactionAudit } from './transactions'
import { normalizeIso } from './time'

export interface BalanceEntryInput {
  accountId: string
  asOf: string                // по умолчанию в форме — сейчас
  newBalanceMinor: number
  /** Для счёта «балансы и движения»: создать корректировку на разницу. Для «только остатки» игнорируется (создаётся всегда). */
  createAdjustment?: boolean
  note?: string | null
}

export interface BalanceEntryPreview {
  previousMinor: number | null        // последняя действующая точка до момента
  previousAsOf: string | null
  calculatedMinor: number
  diffMinor: number                   // новый минус расчётный
  adjustmentRequired: boolean         // «только остатки»: корректировка будет создана сразу
  willBeOpening: boolean              // у счёта нет ни одной действующей записи: это стартовый остаток
}

async function load(ctx: CoreContext, input: BalanceEntryInput) {
  assertMinor(input.newBalanceMinor, 'остаток')
  const asOf = normalizeIso(input.asOf, 'время остатка')
  const account = (await ctx.storage.list('accounts')).find((a) => a.id === input.accountId) ?? fail('NOT_FOUND', 'счёт не найден')
  const calculated = await balanceAt(ctx, account, Date.parse(asOf))
  const existing = await ctx.storage.listTransactions({ accountId: account.id })
  return { account, asOf, calculated, hasAny: existing.length > 0 }
}

export async function previewBalanceEntry(ctx: CoreContext, input: BalanceEntryInput): Promise<BalanceEntryPreview> {
  const { account, asOf, calculated, hasAny } = await load(ctx, input)
  const cps = (await ctx.storage.listCheckpoints({ accountIds: [account.id], asOfTo: asOf }))
    .filter((c) => c.kind === 'balance' && c.status === 'active')
  const prev = cps[cps.length - 1] ?? null
  return {
    previousMinor: prev?.balanceMinor ?? null, previousAsOf: prev?.asOf ?? null,
    calculatedMinor: calculated, diffMinor: input.newBalanceMinor - calculated,
    adjustmentRequired: account.trackingMode === 'balance_only', willBeOpening: !hasAny,
  }
}

export async function commitBalanceEntry(ctx: CoreContext, input: BalanceEntryInput) {
  const { account, asOf, calculated, hasAny } = await load(ctx, input)
  const diff = input.newBalanceMinor - calculated
  const makeAdjustment = diff !== 0 && (account.trackingMode === 'balance_only' || input.createAdjustment === true)

  let adjustment: Transaction | null = null
  if (makeAdjustment) {
    adjustment = await buildTransaction(ctx, {
      accountId: account.id, bookedAt: asOf, type: 'adjustment', amountMinor: diff,
      isOpening: !hasAny, comment: !hasAny ? 'Начальный остаток' : (input.note ?? null),
    }, account)
  }
  const checkpoint: BalanceCheckpoint = await buildCheckpoint(ctx, account, {
    accountId: account.id, asOf, balanceMinor: input.newBalanceMinor, note: input.note ?? null,
  })
  await ctx.storage.applyBatch({
    put: { transactions: adjustment ? [adjustment] : [], checkpoints: [checkpoint] },
    audit: [
      ...(adjustment ? [transactionAudit(ctx, adjustment.isOpening ? 'opening_created' : 'adjustment_created', adjustment)] : []),
      auditEntry(ctx, 'checkpoint_added', { tableName: 'balance_checkpoints', recordId: checkpoint.id, newData: checkpoint as never }),
    ],
  })
  return { adjustment, checkpoint, diffMinor: diff }
}
