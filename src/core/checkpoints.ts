// Контрольные точки: зафиксированный факт «в этот момент остаток был X». В расчёте не участвуют.
import type { Account, BalanceCheckpoint, CheckpointKind } from '../data/types'
import { auditEntry } from './audit'
import { balanceAt } from './balance'
import type { CoreContext } from './context'
import { assertMinor } from './money'
import { fail } from './errors'
import { accountTimeZone, assertUnlocked } from './locks'
import { assertDate, endOfLocalDayMs, normalizeIso } from './time'

export interface CheckpointInput {
  accountId: string; asOf: string; balanceMinor: number
  kind?: CheckpointKind; source?: 'manual' | 'statement'; note?: string | null
}

/** Собирает контрольную точку без записи (для общего пакета). */
export async function buildCheckpoint(ctx: CoreContext, account: Account, input: CheckpointInput): Promise<BalanceCheckpoint> {
  const asOf = normalizeIso(input.asOf, 'время остатка')
  assertMinor(input.balanceMinor, 'остаток')   // остаток может быть любым знаком и нулём
  await assertUnlocked(ctx, account, asOf)
  return {
    id: ctx.newId(), accountId: account.id, asOf, balanceMinor: input.balanceMinor,
    kind: input.kind ?? 'balance', source: input.source ?? 'manual', status: 'active',
    note: input.note ?? null, createdBy: ctx.actor.userId, createdAt: ctx.now().toISOString(),
  }
}

async function requireAccount(ctx: CoreContext, id: string): Promise<Account> {
  const a = (await ctx.storage.list('accounts')).find((x) => x.id === id)
  return a ?? fail('NOT_FOUND', `счёт ${id} не найден`)
}

export async function addCheckpoint(ctx: CoreContext, input: CheckpointInput): Promise<BalanceCheckpoint> {
  const account = await requireAccount(ctx, input.accountId)
  const cp = await buildCheckpoint(ctx, account, input)
  await ctx.storage.applyBatch({
    put: { checkpoints: [cp] },
    audit: [auditEntry(ctx, 'checkpoint_added', { tableName: 'balance_checkpoints', recordId: cp.id, newData: cp as never })],
  })
  return cp
}

/** Ошибочную точку не удаляют, а помечают. */
export async function invalidateCheckpoint(ctx: CoreContext, id: string): Promise<BalanceCheckpoint> {
  const old = (await ctx.storage.listCheckpoints()).find((c) => c.id === id) ?? fail('NOT_FOUND', `точка ${id} не найдена`)
  const account = await requireAccount(ctx, old.accountId)
  await assertUnlocked(ctx, account, old.asOf)
  const next = { ...old, status: 'invalid' as const }
  await ctx.storage.applyBatch({
    put: { checkpoints: [next] },
    audit: [auditEntry(ctx, 'checkpoint_invalidated', { tableName: 'balance_checkpoints', recordId: id, oldData: old as never, newData: next as never })],
  })
  return next
}

export interface CheckpointDiff {
  checkpointId: string; accountId: string; asOf: string
  checkpointMinor: number; calculatedMinor: number
  /** Точка минус расчёт. Ноль = сходится. */
  diffMinor: number
}

export async function getCheckpointDiffs(
  ctx: CoreContext,
  opts: { accountIds?: string[]; includeInvalid?: boolean; throughDate?: string } = {},
): Promise<CheckpointDiff[]> {
  if (opts.throughDate) assertDate(opts.throughDate)
  const accounts = new Map((await ctx.storage.list('accounts')).map((a) => [a.id, a]))
  const cps = await ctx.storage.listCheckpoints({ accountIds: opts.accountIds })
  const out: CheckpointDiff[] = []
  for (const c of cps) {
    if (c.kind !== 'balance') continue                    // оценка портфеля не сверяется с расчётом
    if (c.status === 'invalid' && !opts.includeInvalid) continue
    const a = accounts.get(c.accountId)
    if (!a) continue
    if (opts.throughDate) {
      const tz = await accountTimeZone(ctx, a)
      if (Date.parse(c.asOf) > endOfLocalDayMs(opts.throughDate, tz)) continue
    }
    const calc = await balanceAt(ctx, a, Date.parse(c.asOf))
    out.push({
      checkpointId: c.id, accountId: c.accountId, asOf: c.asOf,
      checkpointMinor: c.balanceMinor, calculatedMinor: calc, diffMinor: c.balanceMinor - calc,
    })
  }
  return out
}
