import type { Account } from '../data/types'
import { periodPoints, pointBalance } from './balancePeriods'
import type { CoreContext } from './context'
import { accountTimeZone } from './locks'
import { iso } from './time'

/**
 * Расчётный остаток. Если у счёта есть периоды остатков (balance_periods), остаток берётся от ближайшей точки отсчёта плюс движения после неё;
 * до первой точки (и у счетов без периодов) считается сумма записей счёта не позже момента, как раньше.
 */
export async function balanceAt(ctx: CoreContext, account: Account, instantMs: number): Promise<number> {
  const txs = await ctx.storage.listTransactions({ accountId: account.id, bookedTo: iso(instantMs) })
  const periods = (await ctx.storage.list('balancePeriods')).filter((p) => p.accountId === account.id)
  if (periods.length > 0) {
    const known = pointBalance(periodPoints(periods, account.id, await accountTimeZone(ctx, account)), txs, instantMs)
    if (known !== null) return known
  }
  return txs.reduce((s, t) => s + t.amountMinor, 0)
}
