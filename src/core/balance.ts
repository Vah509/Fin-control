import type { Account } from '../data/types'
import type { CoreContext } from './context'
import { iso } from './time'

/** Расчётный остаток: сумма действующих записей счёта с booked_at не позже момента (включительно). */
export async function balanceAt(ctx: CoreContext, account: Account, instantMs: number): Promise<number> {
  const txs = await ctx.storage.listTransactions({ accountId: account.id, bookedTo: iso(instantMs) })
  return txs.reduce((s, t) => s + t.amountMinor, 0)
}
