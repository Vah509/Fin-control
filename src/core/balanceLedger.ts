// Учёт остатками: остаток, введённый владельцем на дату (раз в месяц и т.п.). Только контрольная точка kind = entered:
// корректировки и операции не создаются, с расчётом по движениям точка не сверяется.
import type { BalanceCheckpoint } from '../data/types'
import { addCheckpoint } from './checkpoints'
import type { CoreContext } from './context'
import { fail } from './errors'
import { accountTimeZone } from './locks'
import { assertDate, endOfLocalDayMs, iso, localDateOf } from './time'

export interface EnteredBalanceInput {
  accountId: string
  /** Дата остатка ГГГГ-ММ-ДД; остаток фиксируется на конец этого дня в поясе счёта. */
  date: string
  balanceMinor: number
  note?: string | null
}

/** Сохраняет введённый остаток. В закрытый период нельзя (PERIOD_LOCKED); архивный счёт не принимает. */
export async function saveEnteredBalance(ctx: CoreContext, input: EnteredBalanceInput): Promise<BalanceCheckpoint> {
  assertDate(input.date)
  const account = (await ctx.storage.list('accounts')).find((a) => a.id === input.accountId) ?? fail('NOT_FOUND', 'счёт не найден')
  if (account.archivedAt) fail('ACCOUNT_ARCHIVED', 'архивный счёт не принимает остатки')
  const tz = await accountTimeZone(ctx, account)
  return addCheckpoint(ctx, {
    accountId: account.id, asOf: iso(endOfLocalDayMs(input.date, tz)), balanceMinor: input.balanceMinor,
    kind: 'entered', source: 'manual', note: input.note ?? null,
  })
}

export interface EnteredBalance {
  checkpoint: BalanceCheckpoint
  /** Дата остатка ГГГГ-ММ-ДД в поясе счёта. */
  date: string
  balanceMinor: number
}

/** Последний введённый остаток по каждому счёту: самая поздняя дата среди действующих точек, при равных датах более поздняя запись. */
export async function lastEnteredBalances(ctx: CoreContext, accountIds?: string[]): Promise<Map<string, EnteredBalance>> {
  const cps = await ctx.storage.listCheckpoints({ accountIds })
  const best = new Map<string, BalanceCheckpoint>()
  for (const c of cps) {
    if (c.kind !== 'entered' || c.status !== 'active') continue
    const cur = best.get(c.accountId)
    const better = !cur || Date.parse(c.asOf) > Date.parse(cur.asOf) ||
      (Date.parse(c.asOf) === Date.parse(cur.asOf) && c.createdAt >= cur.createdAt)
    if (better) best.set(c.accountId, c)
  }
  const accounts = new Map((await ctx.storage.list('accounts')).map((a) => [a.id, a]))
  const out = new Map<string, EnteredBalance>()
  for (const [id, c] of best) {
    const a = accounts.get(id)
    if (!a) continue
    out.set(id, { checkpoint: c, date: localDateOf(Date.parse(c.asOf), await accountTimeZone(ctx, a)), balanceMinor: c.balanceMinor })
  }
  return out
}
