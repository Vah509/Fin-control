// Сравнение выписки с базой (шаг 3): по каждому счёту выписки сверяются операции за период выписки.
// Ключ строки: счёт + дата (дата списания) + сумма + валюта. Одинаковые строки сравниваются как набор с количеством, порядок не важен.
// Норма: есть в выписке (нет в базе или есть и в базе). Проблема: есть в базе, нет в выписке (db_only).
// Корректировки (стартовые остатки, учёт остатками) в сравнение не входят. Ничего не пишет.
import type { Account, Counterparty, StatementProblemKind, Transaction } from '../../data/types'
import type { CoreContext } from '../context'
import { readSettings, resolveTimeZone } from '../settings'
import { addDays, endOfLocalDayMs, iso, localDateOf, startOfLocalDayMs } from '../time'
import { collectCounterpartyGroups, groupKeyOf, recognizeGroups } from './counterparties'
import type { ParsedStatement, StatementAccount, StatementDecisions } from './types'

/** Допуск по дате при поиске пары (дней). */
export const DATE_TOLERANCE_DAYS = 3
const dayDiff = (a: string, b: string) => Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86_400_000

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
  /** amount_mismatch / date_mismatch: сумма и дата найденной операции в базе */
  dbAmountMinor?: number; dbDate?: string
}
export interface ProblemItem { kind: StatementProblemKind; transactionId: string | null; details: ProblemDetails }

export interface Comparison {
  /** все проблемы: db_only, account_missing, transfer_unpaired, amount_mismatch (сумма расходится), date_mismatch (дата расходится, решения пока нет) */
  problems: ProblemItem[]
  /** ключ cmpKey → строка выписки найдена в базе */
  inDb: Record<string, boolean>
  dbOnly: DbOnlyItem[]
  /** счета выписки (последние 4 цифры), которых нет в базе или признак неоднозначен: по ним сравнения нет */
  missingAccounts: string[]
  /** cmpKey строк, которые владелец решил писать без пары (transfer_unpaired → «обычный») */
  plain: string[]
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

export async function compareWithDb(ctx: CoreContext, st: ParsedStatement, decisions: StatementDecisions = {}): Promise<Comparison> {
  const s = ctx.storage
  const accounts = await s.list('accounts')
  const ids = await s.listAccountIdentifiers()
  const countries = await s.list('countries')
  const settings = readSettings(await s.list('appSettings'))
  const cps = new Map((await s.list('counterparties')).map((c) => [c.id, c.name]))
  const cpOf = await rowCounterparties(ctx, st)
  const out: Comparison = { problems: [], inDb: {}, dbOnly: [], missingAccounts: [], plain: [] }
  const TOL = DATE_TOLERANCE_DAYS

  for (const acc of st.accounts) {
    const dbAcc = findDbAccount(accounts, ids, acc)
    if (!dbAcc) {
      out.missingAccounts.push(acc.key)
      out.problems.push({ kind: 'account_missing', transactionId: null, details: { accountKey: acc.key, accountName: acc.title, date: null, amountMinor: null, currency: acc.currency, type: null, counterparty: null, comment: null,
        message: `счёта нет в базе или признак «номер счёта» (последние 4 цифры …${acc.key}, валюта ${acc.currency}) не добавлен или неоднозначен` } })
      continue
    }
    const tz = resolveTimeZone(dbAcc, countries, settings)
    // операции берутся с запасом в допуск по дате: они нужны для поиска пары, но «только в базе» считаются лишь внутри периода
    const txs = (await s.listTransactions({ accountId: dbAcc.id, bookedFrom: iso(startOfLocalDayMs(addDays(acc.periodStart, -TOL), tz)), bookedTo: iso(endOfLocalDayMs(addDays(acc.periodEnd, TOL), tz)) }))
      .filter((t) => !t.isOpening && t.type !== 'adjustment')
      .sort((a, b) => a.bookedAt.localeCompare(b.bookedAt) || a.id.localeCompare(b.id))
    const dated = txs.map((t) => ({ t, date: localDateOf(Date.parse(t.bookedAt), tz) }))
    const left = new Set(dated.map((d) => d.t.id))
    const take = (date: string, amount: number): boolean => {
      const d = dated.find((x) => left.has(x.t.id) && x.date === date && x.t.amountMinor === amount)
      if (!d) return false
      left.delete(d.t.id)
      return true
    }
    const opKey = (n: number) => cmpKey(acc.key, n, 'operation')
    // 1. «оставить базу» (решение владельца) и точные совпадения «дата + сумма»
    const kept = new Set<number>()
    for (const k of decisions.keepBase ?? []) {
      if (k.a === acc.key && left.has(k.tx) && !kept.has(k.n) && acc.rows.some((r) => r.n === k.n)) { kept.add(k.n); left.delete(k.tx) }
    }
    for (const r of acc.rows) {
      out.inDb[opKey(r.n)] = kept.has(r.n) ? true : take(r.bookingDate, r.amountMinor)
      if (r.feeMinor !== 0) out.inDb[cmpKey(acc.key, r.n, 'fee')] = take(r.bookingDate, r.feeMinor)
    }
    const unmatched = () => acc.rows.filter((r) => !out.inDb[opKey(r.n)])
    const candidates = (r: StatementAccount['rows'][number], pred: (d: { t: Transaction; date: string }) => boolean) =>
      dated
        .filter((d) => left.has(d.t.id) && dayDiff(d.date, r.bookingDate) <= TOL && pred(d)
          && !(decisions.distinct ?? []).some((x) => x.a === acc.key && x.n === r.n && x.tx === d.t.id))
        .sort((a, b) => dayDiff(a.date, r.bookingDate) - dayDiff(b.date, r.bookingDate))
    const base = (r: StatementAccount['rows'][number], c: { t: Transaction; date: string }, message: string): ProblemItem => ({
      kind: 'date_mismatch', transactionId: c.t.id,
      details: { accountKey: acc.key, accountName: dbAcc.name, date: r.bookingDate, amountMinor: r.amountMinor, currency: acc.currency, type: c.t.type,
        counterparty: c.t.counterpartyId ? cps.get(c.t.counterpartyId) ?? null : null, comment: c.t.comment, message, n: r.n, dbAmountMinor: c.t.amountMinor, dbDate: c.date },
    })
    // 2. та же сумма, дата другая (в допуске): пара найдена, решения пока нет
    for (const r of unmatched()) {
      const c = candidates(r, (d) => d.t.amountMinor === r.amountMinor)[0]
      if (!c) continue
      left.delete(c.t.id); out.inDb[opKey(r.n)] = true
      out.problems.push(base(r, c, `в выписке ${r.bookingDate}, в базе ${c.date}`))
    }
    // 3. тот же контрагент и знак, сумма другая (в допуске)
    for (const r of unmatched()) {
      const cp = cpOf(r.counterparty)
      if (!cp) continue
      const c = candidates(r, (d) => d.t.counterpartyId === cp.id && !d.t.transferId && d.t.type !== 'transfer' && Math.sign(d.t.amountMinor) === Math.sign(r.amountMinor))[0]
      if (!c) continue
      left.delete(c.t.id); out.inDb[opKey(r.n)] = true
      const p = base(r, c, `в выписке ${formatAmt(r.amountMinor)}, в базе ${formatAmt(c.t.amountMinor)}`)
      out.problems.push({ ...p, kind: 'amount_mismatch' })
    }
    // 4. остальные строки выписки новые; перевод на свой счёт без возможности создать пару это проблема (если не выбрано «обычный»)
    for (const r of unmatched()) {
      const pt = pairTarget(accounts, cpOf(r.counterparty), dbAcc)
      if ((decisions.plain ?? []).some((x) => x.a === acc.key && x.n === r.n)) { out.plain.push(opKey(r.n)); continue }
      if (pt && !pt.ok) {
        out.problems.push({ kind: 'transfer_unpaired', transactionId: null, details: { accountKey: acc.key, accountName: dbAcc.name, date: r.bookingDate, amountMinor: r.amountMinor, currency: acc.currency,
          type: 'transfer', counterparty: cpOf(r.counterparty)?.name ?? null, comment: null, message: pt.reason, n: r.n } })
      }
    }
    // 5. операции базы внутри периода, которых нет в выписке
    for (const d of dated) {
      if (!left.has(d.t.id) || d.date < acc.periodStart || d.date > acc.periodEnd) continue
      const t = d.t
      const item = { transactionId: t.id, accountKey: acc.key, accountName: dbAcc.name, date: d.date, amountMinor: t.amountMinor, currency: acc.currency, type: t.type,
        counterparty: t.counterpartyId ? cps.get(t.counterpartyId) ?? null : null, comment: t.comment }
      if (!(decisions.keepDb ?? []).includes(t.id)) out.problems.push({ kind: 'db_only', transactionId: t.id, details: { ...item } })
      out.dbOnly.push(item)
    }
  }
  out.dbOnly.sort((a, b) => a.date.localeCompare(b.date) || a.accountKey.localeCompare(b.accountKey) || a.amountMinor - b.amountMinor)
  return out
}

const formatAmt = (m: number) => `${m < 0 ? '−' : '+'}${(Math.abs(m) / 100).toFixed(2)}`
