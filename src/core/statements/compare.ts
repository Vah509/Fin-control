// Сравнение выписки с базой (шаг 3): по каждому счёту выписки сверяются операции за период выписки.
// Ключ строки: счёт + дата (дата списания) + сумма + валюта. Одинаковые строки сравниваются как набор с количеством, порядок не важен.
// Норма: есть в выписке (нет в базе или есть и в базе). Проблема: есть в базе, нет в выписке (db_only).
// Корректировки (стартовые остатки, учёт остатками) в сравнение не входят. Ничего не пишет.
import type { Account, Counterparty, StatementProblemKind, Transaction } from '../../data/types'
import type { CoreContext } from '../context'
import { readSettings, resolveTimeZone } from '../settings'
import { endOfLocalDayMs, iso, localDateOf, startOfLocalDayMs } from '../time'
import { collectCounterpartyGroups, groupKeyOf, recognizeGroups } from './counterparties'
import type { ParsedStatement, StatementAccount } from './types'

export type ItemKind = 'operation' | 'fee'
export const cmpKey = (accountKey: string, n: number, kind: ItemKind) => `${accountKey}:${n}:${kind}`

export interface DbOnlyItem {
  transactionId: string; accountKey: string; accountName: string
  date: string; amountMinor: number; currency: string; type: string
  counterparty: string | null; comment: string | null
}
/** Данные проблемы для показа (хранятся в `statement_problems.details`). */
export interface ProblemDetails {
  accountKey: string; accountName: string; date: string | null; amountMinor: number | null; currency: string | null
  type: string | null; counterparty: string | null; comment: string | null; message?: string; n?: number
}
export interface ProblemItem { kind: StatementProblemKind; transactionId: string | null; details: ProblemDetails }

export interface Comparison {
  /** все проблемы: db_only (есть в базе, нет в выписке), account_missing (счёта нет в базе), transfer_unpaired (перевод без пары) */
  problems: ProblemItem[]
  /** ключ cmpKey → строка выписки найдена в базе */
  inDb: Record<string, boolean>
  dbOnly: DbOnlyItem[]
  /** счета выписки (последние 4 цифры), которых нет в базе или признак неоднозначен: по ним сравнения нет */
  missingAccounts: string[]
}

const isActive = (v: { validFrom: string; validTo: string | null }, d: string) => v.validFrom <= d && d <= (v.validTo ?? '9999-12-31')

export function findDbAccount(accounts: Account[], ids: { accountId: string; kind: string; last4: string | null; validFrom: string; validTo: string | null }[], acc: StatementAccount): Account | null {
  const hit = new Set(ids.filter((i) => i.kind === 'account_number' && i.last4 === acc.key && isActive(i, acc.periodEnd)).map((i) => i.accountId))
  if (hit.size !== 1) return null
  const a = accounts.find((x) => x.id === [...hit][0])
  return a && a.currencyKey.toUpperCase() === acc.currency.toUpperCase() ? a : null
}

/** Перевод на свой счёт: null = не перевод; ok = счёт-получатель в базе, та же валюта, не архивный (парная запись создаётся сразу). */
export function pairTarget(accounts: Account[], cp: Counterparty | null, from: Account): { ok: true; target: Account } | { ok: false; reason: string } | null {
  if (!cp || cp.kind !== 'own_account') return null
  const target = cp.accountId ? accounts.find((a) => a.id === cp.accountId) : undefined
  if (!target) return { ok: false, reason: `контрагент «${cp.name}» не привязан к счёту в базе` }
  if (target.id === from.id) return { ok: false, reason: 'перевод на тот же счёт' }
  if (target.archivedAt) return { ok: false, reason: `счёт «${target.name}» архивный` }
  if (target.currencyKey !== from.currencyKey) return { ok: false, reason: `разная валюта (${from.currencyKey.toUpperCase()} → ${target.currencyKey.toUpperCase()}), парная запись пока не создаётся` }
  return { ok: true, target }
}

/** Опознанный контрагент строки выписки (по справочнику на сегодня) или null. */
export async function rowCounterparties(ctx: CoreContext, st: ParsedStatement): Promise<(c: { name: string; iban: string | null }) => Counterparty | null> {
  const groups = collectCounterpartyGroups(st)
  const found = await recognizeGroups(ctx, groups)
  const map = new Map<string, Counterparty | null>()
  groups.forEach((g, i) => map.set(groupKeyOf({ name: g.text, iban: g.iban }), found[i] ?? null))
  return (c) => map.get(groupKeyOf(c)) ?? null
}

const bucketKey = (date: string, amount: number) => `${date}|${amount}`

export async function compareWithDb(ctx: CoreContext, st: ParsedStatement): Promise<Comparison> {
  const s = ctx.storage
  const accounts = await s.list('accounts')
  const ids = await s.listAccountIdentifiers()
  const countries = await s.list('countries')
  const settings = readSettings(await s.list('appSettings'))
  const cps = new Map((await s.list('counterparties')).map((c) => [c.id, c.name]))
  const cpOf = await rowCounterparties(ctx, st)
  const out: Comparison = { problems: [], inDb: {}, dbOnly: [], missingAccounts: [] }

  for (const acc of st.accounts) {
    const dbAcc = findDbAccount(accounts, ids, acc)
    if (!dbAcc) {
      out.missingAccounts.push(acc.key)
      out.problems.push({ kind: 'account_missing', transactionId: null, details: { accountKey: acc.key, accountName: acc.title, date: null, amountMinor: null, currency: acc.currency, type: null, counterparty: null, comment: null,
        message: `счёта нет в базе или признак «номер счёта» (последние 4 цифры …${acc.key}, валюта ${acc.currency}) не добавлен или неоднозначен` } })
      continue
    }
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
      if (!out.inDb[cmpKey(acc.key, r.n, 'operation')]) {
        const pt = pairTarget(accounts, cpOf(r.counterparty), dbAcc)
        if (pt && !pt.ok) {
          out.problems.push({ kind: 'transfer_unpaired', transactionId: null, details: { accountKey: acc.key, accountName: dbAcc.name, date: r.bookingDate, amountMinor: r.amountMinor, currency: acc.currency,
            type: 'transfer', counterparty: cpOf(r.counterparty)?.name ?? null, comment: null, message: pt.reason, n: r.n } })
        }
      }
    }
    for (const [k, list] of buckets) {
      const date = k.split('|')[0]!
      for (const t of list) {
        out.problems.push({ kind: 'db_only', transactionId: t.id, details: { accountKey: acc.key, accountName: dbAcc.name, date, amountMinor: t.amountMinor, currency: acc.currency, type: t.type,
          counterparty: t.counterpartyId ? cps.get(t.counterpartyId) ?? null : null, comment: t.comment } })
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
