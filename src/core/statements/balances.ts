// Сверка остатков выписки с базой перед записью (шаг 4): начальный остаток выписки = остаток в базе на начало периода,
// конечный остаток выписки = остаток в базе на конец периода плюс операции, которые будут записаны.
import { balanceAt } from '../balance'
import type { CoreContext } from '../context'
import { readSettings, resolveTimeZone } from '../settings'
import { endOfLocalDayMs, startOfLocalDayMs } from '../time'
import { findDbAccount, type Comparison } from './compare'
import type { ParsedStatement } from './types'
import { buildStatementTransactions } from './write'

export interface BalanceCheckItem {
  accountKey: string
  accountName: string
  currency: string
  periodStart: string
  periodEnd: string
  /** остаток в базе на начало периода и начальный остаток выписки */
  startDbMinor: number
  startStmtMinor: number
  /** ожидаемый остаток в базе после записи и конечный остаток выписки */
  endExpectedMinor: number
  endStmtMinor: number
  startOk: boolean
  endOk: boolean
}
export interface BalanceCheck { ok: boolean; items: BalanceCheckItem[] }

/** Остатки не сходятся, если хоть по одному счёту не равен начальный или конечный. Счета, которых нет в базе, не проверяются (это проблема «Счёта нет»). */
export async function checkStatementBalances(ctx: CoreContext, st: ParsedStatement, cmp: Comparison): Promise<BalanceCheck> {
  const s = ctx.storage
  const accounts = await s.list('accounts')
  const ids = await s.listAccountIdentifiers()
  const countries = await s.list('countries')
  const settings = readSettings(await s.list('appSettings'))
  const txs = await buildStatementTransactions(ctx, st, cmp)
  const items: BalanceCheckItem[] = []
  for (const acc of st.accounts) {
    const db = findDbAccount(accounts, ids, acc)
    if (!db) continue
    const tz = resolveTimeZone(db, countries, settings)
    const startDb = await balanceAt(ctx, db, startOfLocalDayMs(acc.periodStart, tz) - 1)
    const added = txs.filter((t) => t.accountId === db.id).reduce((n, t) => n + t.amountMinor, 0)
    const endExpected = (await balanceAt(ctx, db, endOfLocalDayMs(acc.periodEnd, tz))) + added
    items.push({
      accountKey: acc.key, accountName: db.name, currency: acc.currency, periodStart: acc.periodStart, periodEnd: acc.periodEnd,
      startDbMinor: startDb, startStmtMinor: acc.openingMinor, endExpectedMinor: endExpected, endStmtMinor: acc.closingMinor,
      startOk: startDb === acc.openingMinor, endOk: endExpected === acc.closingMinor,
    })
  }
  return { ok: items.every((i) => i.startOk && i.endOk), items }
}
