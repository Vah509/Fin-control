// Срез на дату: остаток по счетам и итоги; по валютам и в одной валюте по курсу на дату.
// Каждый счёт округляется отдельно. Корректировки (не начальные) показываются отдельной строкой «неучтённое».
import { periodPoints, pointBalance, pointGaps } from './balancePeriods'
import type { Account } from '../data/types'
import type { CoreContext } from './context'
import { fail } from './errors'
import { FxResolver } from './fx'
import { convertMinor } from './money'
import { lastEnteredBalances } from './balanceLedger'
import { readSettings, resolveTimeZone } from './settings'
import { assertDate, endOfLocalDayMs, iso, startOfLocalDayMs } from './time'

export interface SnapshotInput {
  date: string
  accountIds?: string[]
  projectIds?: string[]
  baseCurrency?: string
}

export interface Converted { minor: number | null; hasRate: boolean }
export interface SnapshotRow {
  accountId: string; key: string; name: string; type: Account['type']
  projectId: string; countryKey: string; holder: string | null; institutionId: string | null
  currencyKey: string
  balanceMinor: number; unaccountedMinor: number
  /** раньше первой точки отсчёта остатка (balance_periods): остаток неизвестен */
  noBalance?: boolean
  balance: Converted; unaccounted: Converted
}
export interface CurrencyTotal { currencyKey: string; balanceMinor: number; unaccountedMinor: number }
export interface SnapshotTotals {
  byCurrency: CurrencyTotal[]
  baseCurrency: string
  baseMinor: number               // сумма тех счетов, для которых есть курс
  unaccountedBaseMinor: number
  complete: boolean               // false = у части счетов «нет курса»
  missingRateCurrencies: string[]
}
export interface Snapshot { date: string; rows: SnapshotRow[]; totals: SnapshotTotals }

export type GroupBy = 'country' | 'type' | 'holder' | 'project' | 'institution'

async function env(ctx: CoreContext, baseOverride: string | undefined, date: string) {
  const [accounts, countries, settingsRows, currencies, rates, prios] = await Promise.all([
    ctx.storage.list('accounts'), ctx.storage.list('countries'), ctx.storage.list('appSettings'),
    ctx.storage.list('currencies'), ctx.storage.listFxRates({ toDate: date }), ctx.storage.list('fxSourcePriorities'),
  ])
  const settings = readSettings(settingsRows)
  const base = baseOverride ?? settings.baseCurrency ?? fail('INVALID_FIELD', 'не задана базовая валюта (base_currency)')
  if (!currencies.some((c) => c.key === base)) fail('NOT_FOUND', `валюта ${base} не найдена`)
  const dec = new Map(currencies.map((c) => [c.key, c.decimals]))
  return { accounts, countries, settings, base, dec, fx: new FxResolver(rates, prios, settings.fxPivotCurrency) }
}

function convert(e: Awaited<ReturnType<typeof env>>, minor: number, cur: string, date: string): Converted {
  const rate = e.fx.rate(cur, e.base, date)
  if (!rate) return { minor: null, hasRate: false }
  return { minor: convertMinor(minor, e.dec.get(cur) ?? 2, e.dec.get(e.base) ?? 2, rate), hasRate: true }
}

export function summarize(rows: SnapshotRow[], baseCurrency: string): SnapshotTotals {
  const by = new Map<string, CurrencyTotal>()
  let baseMinor = 0, unBase = 0
  const missing = new Set<string>()
  for (const r of rows) {
    const t = by.get(r.currencyKey) ?? { currencyKey: r.currencyKey, balanceMinor: 0, unaccountedMinor: 0 }
    t.balanceMinor += r.balanceMinor; t.unaccountedMinor += r.unaccountedMinor
    by.set(r.currencyKey, t)
    if (r.balance.hasRate) baseMinor += r.balance.minor!; else missing.add(r.currencyKey)
    if (r.unaccounted.hasRate) unBase += r.unaccounted.minor!
  }
  return {
    byCurrency: [...by.values()].sort((a, b) => a.currencyKey.localeCompare(b.currencyKey)),
    baseCurrency, baseMinor, unaccountedBaseMinor: unBase,
    complete: missing.size === 0, missingRateCurrencies: [...missing].sort(),
  }
}

export async function getSnapshot(ctx: CoreContext, input: SnapshotInput): Promise<Snapshot> {
  assertDate(input.date)
  const e = await env(ctx, input.baseCurrency, input.date)
  const chosen = e.accounts
    .filter((a) => !input.accountIds || input.accountIds.includes(a.id))
    .filter((a) => !input.projectIds || input.projectIds.includes(a.projectId))
    .sort((a, b) => a.sortOrder - b.sortOrder || a.key.localeCompare(b.key))

  const rows: SnapshotRow[] = []
  const periods = await ctx.storage.list('balancePeriods')
  for (const a of chosen) {
    const tz = resolveTimeZone(a, e.countries, e.settings)
    const end = endOfLocalDayMs(input.date, tz)
    const txs = await ctx.storage.listTransactions({ accountId: a.id, bookedTo: iso(end) })
    const pts = periodPoints(periods, a.id, tz)
    const known = pts.length > 0 ? pointBalance(pts, txs, end) : null
    const noBalance = pts.length > 0 && known === null
    const balance = noBalance ? 0 : (known ?? txs.reduce((s, t) => s + t.amountMinor, 0))
    const un = txs.filter((t) => t.type === 'adjustment' && !t.isOpening).reduce((s, t) => s + t.amountMinor, 0)
      + pointGaps(pts, txs).reduce((s, g) => s + g.gapMinor, 0)
    if (a.archivedAt && Date.parse(a.archivedAt) <= end && balance === 0) continue   // архивный нулевой счёт скрыт
    rows.push({
      accountId: a.id, key: a.key, name: a.name, type: a.type, projectId: a.projectId,
      countryKey: a.countryKey, holder: a.holder, institutionId: a.institutionId, currencyKey: a.currencyKey,
      balanceMinor: balance, unaccountedMinor: un, ...(noBalance ? { noBalance: true } : {}),
      balance: convert(e, balance, a.currencyKey, input.date),
      unaccounted: convert(e, un, a.currencyKey, input.date),
    })
  }
  return { date: input.date, rows, totals: summarize(rows, e.base) }
}

export interface SnapshotGroup { groupKey: string; rows: SnapshotRow[]; totals: SnapshotTotals }

export function groupSnapshot(s: Snapshot, by: GroupBy): SnapshotGroup[] {
  const pick = (r: SnapshotRow) =>
    by === 'country' ? r.countryKey : by === 'type' ? r.type : by === 'holder' ? (r.holder ?? '') :
    by === 'project' ? r.projectId : (r.institutionId ?? '')
  const m = new Map<string, SnapshotRow[]>()
  for (const r of s.rows) {
    const k = pick(r)
    const l = m.get(k)
    if (l) l.push(r); else m.set(k, [r])
  }
  return [...m.entries()].map(([groupKey, rows]) => ({ groupKey, rows, totals: summarize(rows, s.totals.baseCurrency) }))
}

/** Неучтённая разница за период (включительно, даты в поясе счёта): сумма корректировок, кроме начальных. Ноль = учёт полный. */
export async function getUnaccounted(
  ctx: CoreContext, input: { from: string; to: string; accountIds?: string[]; projectIds?: string[]; baseCurrency?: string },
) {
  assertDate(input.from); assertDate(input.to)
  const e = await env(ctx, input.baseCurrency, input.to)
  const periods = await ctx.storage.list('balancePeriods')
  const out: { accountId: string; currencyKey: string; minor: number; converted: Converted }[] = []
  for (const a of e.accounts) {
    if (input.accountIds && !input.accountIds.includes(a.id)) continue
    if (input.projectIds && !input.projectIds.includes(a.projectId)) continue
    const tz = resolveTimeZone(a, e.countries, e.settings)
    const txs = await ctx.storage.listTransactions({
      accountId: a.id, types: ['adjustment'], isOpening: false,
      bookedFrom: iso(startOfLocalDayMs(input.from, tz)), bookedTo: iso(endOfLocalDayMs(input.to, tz)),
    })
    const pts = periodPoints(periods, a.id, tz)
    const gaps = pts.length > 1
      ? pointGaps(pts, await ctx.storage.listTransactions({ accountId: a.id })).filter((g) => g.atMs >= startOfLocalDayMs(input.from, tz) && g.atMs <= endOfLocalDayMs(input.to, tz))
      : []
    const minor = txs.reduce((s, t) => s + t.amountMinor, 0) + gaps.reduce((s, g) => s + g.gapMinor, 0)
    if (minor !== 0) out.push({ accountId: a.id, currencyKey: a.currencyKey, minor, converted: convert(e, minor, a.currencyKey, input.to) })
  }
  return out
}

export interface GroupTotal { ids: string[]; baseMinor: number; complete: boolean }

/**
 * Суммы групп раздела: группа = счета между разделителями (или до начала/конца списка).
 * `items`: id счетов и разделителей в порядке показа. Пустые группы пропускаются; счета без строки среза не считаются.
 */
export function groupTotalsByDividers(items: string[], rows: SnapshotRow[], baseCurrency: string): GroupTotal[] {
  const byId = new Map(rows.map((r) => [r.accountId, r]))
  const out: GroupTotal[] = []
  let cur: string[] = []
  const flush = () => {
    const rs = cur.map((id) => byId.get(id)).filter((r): r is SnapshotRow => !!r)
    if (rs.length) { const t = summarize(rs, baseCurrency); out.push({ ids: cur.filter((id) => byId.has(id)), baseMinor: t.baseMinor, complete: t.complete }) }
    cur = []
  }
  for (const id of items) { if (id.startsWith('div:')) flush(); else cur.push(id) }
  flush()
  return out
}

export interface SectionTotal { projectId: string; baseMinor: number; complete: boolean; missingRateCurrencies: string[] }

/** Итого по каждому разделу в базовой валюте. `complete = false`: у части счетов нет курса, сумму показывать нельзя. */
export function sectionTotals(s: Snapshot): Map<string, SectionTotal> {
  const out = new Map<string, SectionTotal>()
  for (const g of groupSnapshot(s, 'project')) {
    out.set(g.groupKey, { projectId: g.groupKey, baseMinor: g.totals.baseMinor, complete: g.totals.complete, missingRateCurrencies: g.totals.missingRateCurrencies })
  }
  return out
}

export interface EnteredSnapshot {
  rows: SnapshotRow[]
  /** Дата последнего введённого остатка по счёту (ГГГГ-ММ-ДД в поясе счёта). */
  dateByAccount: Record<string, string>
  /** Счета, по которым остаток ещё не вводился («нет данных»). */
  missing: string[]
  totals: SnapshotTotals
}

/**
 * Учёт остатками: по каждому счёту берётся последний введённый остаток (точка kind = entered, действующая,
 * самая поздняя по дате; при равных датах более поздняя запись). Пересчёт в базовую валюту по курсу на `rateDate`.
 * Движения не участвуют. Счета без остатка попадают в `missing` и в итоги не входят.
 */
export async function getEnteredSnapshot(
  ctx: CoreContext, input: { rateDate: string; accountIds?: string[]; baseCurrency?: string },
): Promise<EnteredSnapshot> {
  assertDate(input.rateDate)
  const e = await env(ctx, input.baseCurrency, input.rateDate)
  const chosen = e.accounts
    .filter((a) => !input.accountIds || input.accountIds.includes(a.id))
    .sort((a, b) => a.sortOrder - b.sortOrder || a.key.localeCompare(b.key))
  const last = await lastEnteredBalances(ctx, chosen.map((a) => a.id))
  const rows: SnapshotRow[] = []
  const missing: string[] = []
  const dateByAccount: Record<string, string> = {}
  for (const a of chosen) {
    const cp = last.get(a.id)
    if (!cp) { if (!a.archivedAt) missing.push(a.id); continue }
    dateByAccount[a.id] = cp.date
    rows.push({
      accountId: a.id, key: a.key, name: a.name, type: a.type, projectId: a.projectId,
      countryKey: a.countryKey, holder: a.holder, institutionId: a.institutionId, currencyKey: a.currencyKey,
      balanceMinor: cp.balanceMinor, unaccountedMinor: 0,
      balance: convert(e, cp.balanceMinor, a.currencyKey, input.rateDate),
      unaccounted: { minor: 0, hasRate: true },
    })
  }
  return { rows, dateByAccount, missing, totals: summarize(rows, e.base) }
}

export interface TotalProject { projectId: string; baseMinor: number; complete: boolean }
export interface TotalGroup { projects: TotalProject[]; baseMinor: number; complete: boolean }
export interface ProjectTotals {
  /** Группы разделов между разделителями (пустые пропущены). */
  groups: TotalGroup[]
  /** Есть ли хоть один разделитель между непустыми группами (тогда у групп показываются суммы). */
  split: boolean
  /** Итог только по включённым разделам: по валютам и в базовой валюте. */
  totals: SnapshotTotals
}

/**
 * Блок «Общий итог»: `items` = id разделов и разделителей в порядке показа (`totalItems`). Сумма группы = разделы от
 * разделителя до следующего. В итог входят только разделы из `items`; счета и курсы как в `rows`. Раздел без строк пропускается.
 */
export function projectTotals(items: string[], rows: SnapshotRow[], baseCurrency: string): ProjectTotals {
  const groups: TotalGroup[] = []
  const used: SnapshotRow[] = []
  let cur: TotalProject[] = []
  let curRows: SnapshotRow[] = []
  const flush = () => {
    if (cur.length) { const t = summarize(curRows, baseCurrency); groups.push({ projects: cur, baseMinor: t.baseMinor, complete: t.complete }) }
    cur = []; curRows = []
  }
  for (const id of items) {
    if (id.startsWith('div:')) { flush(); continue }
    const rs = rows.filter((r) => r.projectId === id)
    if (!rs.length) continue
    const t = summarize(rs, baseCurrency)
    cur.push({ projectId: id, baseMinor: t.baseMinor, complete: t.complete })
    curRows.push(...rs); used.push(...rs)
  }
  flush()
  return { groups, split: groups.length > 1, totals: summarize(used, baseCurrency) }
}
