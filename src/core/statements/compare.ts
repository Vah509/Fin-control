// Сравнение выписки с базой (шаг 3): по каждому счёту выписки сверяются операции за период выписки.
// Ключ строки: счёт + дата (дата списания) + сумма + валюта. Одинаковые строки сравниваются как набор с количеством, порядок не важен.
// Норма: есть в выписке (нет в базе или есть и в базе). Проблема: есть в базе, нет в выписке (db_only).
// Корректировки (стартовые остатки, учёт остатками) в сравнение не входят. Ничего не пишет.
import type { Account, Transaction } from '../../data/types'
import type { CoreContext } from '../context'
import { readSettings, resolveTimeZone } from '../settings'
import { endOfLocalDayMs, iso, localDateOf, startOfLocalDayMs } from '../time'
import type { ParsedStatement, StatementAccount } from './types'

export type ItemKind = 'operation' | 'fee'
export const cmpKey = (accountKey: string, n: number, kind: ItemKind) => `${accountKey}:${n}:${kind}`

export interface DbOnlyItem {
  transactionId: string; accountKey: string; accountName: string
  date: string; amountMinor: number; currency: string; type: string
  counterparty: string | null; comment: string | null
}
export interface Comparison {
  /** ключ cmpKey → строка выписки найдена в базе */
  inDb: Record<string, boolean>
  dbOnly: DbOnlyItem[]
  /** счета выписки (последние 4 цифры), которых нет в базе или признак неоднозначен: по ним сравнения нет */
  missingAccounts: string[]
}

const isActive = (v: { validFrom: string; validTo: string | null }, d: string) => v.validFrom <= d && d <= (v.validTo ?? '9999-12-31')

function findDbAccount(accounts: Account[], ids: { accountId: string; kind: string; last4: string | null; validFrom: string; validTo: string | null }[], acc: StatementAccount): Account | null {
  const hit = new Set(ids.filter((i) => i.kind === 'account_number' && i.last4 === acc.key && isActive(i, acc.periodEnd)).map((i) => i.accountId))
  if (hit.size !== 1) return null
  const a = accounts.find((x) => x.id === [...hit][0])
  return a && a.currencyKey.toUpperCase() === acc.currency.toUpperCase() ? a : null
}

const bucketKey = (date: string, amount: number) => `${date}|${amount}`

export async function compareWithDb(ctx: CoreContext, st: ParsedStatement): Promise<Comparison> {
  const s = ctx.storage
  const accounts = await s.list('accounts')
  const ids = await s.listAccountIdentifiers()
  const countries = await s.list('countries')
  const settings = readSettings(await s.list('appSettings'))
  const cps = new Map((await s.list('counterparties')).map((c) => [c.id, c.name]))
  const out: Comparison = { inDb: {}, dbOnly: [], missingAccounts: [] }

  for (const acc of st.accounts) {
    const dbAcc = findDbAccount(accounts, ids, acc)
    if (!dbAcc) { out.missingAccounts.push(acc.key); continue }
    const tz = resolveTimeZone(dbAcc, countries, settings)
    const txs = (await s.listTransactions({ accountId: dbAcc.id, bookedFrom: iso(startOfLocalDayMs(acc.periodStart, tz)), bookedTo: iso(endOfLocalDayMs(acc.periodEnd, tz)) }))
      .filter((t) => !t.isOpening && t.type !== 'adjustment')
    const buckets = new Map<string, Transaction[]>()
    for (const t of txs.sort((a, b) => a.bookedAt.localeCompare(b.bookedAt) || a.id.localeCompare(b.id))) {
      const k = bucketKey(localDateOf(Date.parse(t.bookedAt), tz), t.amountMinor)
      const list = buckets.get(k)
      if (list) list.push(t); else buckets.set(k, [t])
    }
    const take = (date: string, amount: number): boolean => {
      const list = buckets.get(bucketKey(date, amount))
      if (!list?.length) return false
      list.shift()
      return true
    }
    for (const r of acc.rows) {
      out.inDb[cmpKey(acc.key, r.n, 'operation')] = take(r.bookingDate, r.amountMinor)
      if (r.feeMinor !== 0) out.inDb[cmpKey(acc.key, r.n, 'fee')] = take(r.bookingDate, r.feeMinor)
    }
    for (const [k, list] of buckets) {
      const date = k.split('|')[0]!
      for (const t of list) {
        out.dbOnly.push({
          transactionId: t.id, accountKey: acc.key, accountName: dbAcc.name, date, amountMinor: t.amountMinor, currency: acc.currency,
          type: t.type, counterparty: t.counterpartyId ? cps.get(t.counterpartyId) ?? null : null, comment: t.comment,
        })
      }
    }
  }
  out.dbOnly.sort((a, b) => a.date.localeCompare(b.date) || a.accountKey.localeCompare(b.accountKey) || a.amountMinor - b.amountMinor)
  return out
}
