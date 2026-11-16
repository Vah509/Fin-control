// Разбор принятого ответа чата: приложение само пересчитывает цепочку остатков, итоги и число строк,
// сопоставляет счета и контрагентов и находит расхождения по каталогу (docs/IMPORT-DESIGN.md, разделы 7-8).
// Ничего не пишет в базу: запись делает importLoad.ts по решениям владельца.
import type {
  Account, Counterparty, ImportAccountDecision, ImportCpDecision, ImportDecisions, ImportJob, ImportReviewState, Transaction,
} from '../data/types'
import type { CoreContext } from './context'
import { fail } from './errors'
import { getLockedThrough, accountTimeZone } from './locks'
import { formatMinor, parseMinor } from './money'
import { localDateOf, startOfLocalDayMs } from './time'
import { crossCheck, groupResponses, type ImportDoc, type ParsedRow, type ParsedStatement, type ResponseGroup } from './importResponse'

export const emptyDecisions = (): ImportDecisions => ({
  primary: null, accounts: {}, openingFix: {}, entryFix: {}, counterparties: {}, ownAccounts: {}, identifiers: {},
})
export function readReview(job: ImportJob): ImportReviewState {
  const r = job.review ?? {}
  return { responses: r.responses ?? [], decisions: { ...emptyDecisions(), ...(r.decisions ?? {}) }, result: r.result ?? null }
}
export const normName = (s: string) => s.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase()

export interface ReviewIssue { code: string; text: string }
export interface ReviewRow {
  n: number; bookedAtUtc: string; local: string; amountMinor: number; description: string
  originalMinor: number | null; originalCurrency: string | null
  duplicate: boolean; counterpartyId: string | null; groupKey: string | null; dedupeHash: string
  src: ParsedRow
}
export interface ReviewStatement {
  key: string; mask: string | null; aiAccountKey: string | null
  accountId: string | null; proposedAccountId: string | null
  accountState: 'identified' | 'confirmed' | 'needs_decision' | 'skipped'
  bindMask: boolean                    // при загрузке привязать маску к счёту
  currencyKey: string | null; decimals: number
  periodStart: string | null; periodEnd: string | null; rowsInFile: number
  openingMinor: number | null; closingMinor: number | null
  incomeMinor: number; expenseMinor: number
  rows: ReviewRow[]
  errors: ReviewIssue[]                // блокируют загрузку карты (кроме пропуска)
  warnings: ReviewIssue[]              // справочно
  openingDiffMinor: number | null; openingFix: 'adjust' | 'keep' | null; isFirstImport: boolean
  entryDiffMinor: number | null; entryFix: 'adjust' | 'keep' | null; entryAtUtc: string | null
  noCardData?: never
}
export interface CpGroup {
  groupKey: string; rawName: string; count: number; totalMinor: number
  decision: ImportCpDecision | null; chatKey: string | null
}
export interface OwnSuggestion { mask: string; accountId: string; counterpartyId: string | null; counterpartyName: string | null; count: number; decision: boolean | null }
export interface IdentifierSuggestion { id: string; counterpartyId: string; counterpartyName: string; value: string; decision: 'add' | 'reject' | null }
export interface ImportReview {
  job: ImportJob
  groups: { key: string; aiName: string; complete: boolean; have: number[]; parts: number; isPrimary: boolean }[]
  aiName: string | null
  statements: ReviewStatement[]
  missingCards: { accountId: string; name: string }[]
  cpGroups: CpGroup[]; own: OwnSuggestion[]; identifierSuggestions: IdentifierSuggestion[]
  crossDiffs: string[] | null
  blockers: string[]
  canLoad: boolean
}

/** Хэш строки для защиты от дублей: счёт, время, сумма, валюта, описание, порядковый номер среди одинаковых. */
export const rowDedupeKey = (accountId: string, bookedAtUtc: string, amountMinor: number, cur: string, desc: string, occ: number) =>
  `${accountId}|${bookedAtUtc}|${amountMinor}|${cur}|${normName(desc)}|${occ}`
async function sha(text: string): Promise<string> {
  const b = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('')
}

function localToUtc(local: string, tz: string): string | null {
  const m = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(local.trim())
  if (!m) return null
  try { return new Date(startOfLocalDayMs(m[1]!, tz) + (+m[2]! * 3600 + +m[3]! * 60 + +(m[4] ?? 0)) * 1000).toISOString() } catch { return null }
}
const patternMatch = (pattern: string, text: string) => {
  const p = normName(pattern)
  if (/[*%]/.test(p)) {
    const re = new RegExp('^' + p.split(/[*%]+/).map((x) => x.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$')
    return re.test(text)
  }
  return text.includes(p)
}

export async function analyzeImport(ctx: CoreContext, jobId: string): Promise<ImportReview> {
  const s = ctx.storage
  const job = (await s.list('importJobs')).find((j) => j.id === jobId) ?? fail('NOT_FOUND', `задание ${jobId} не найдено`)
  const review = readReview(job)
  const dec = review.decisions
  const [accounts, currencies, countries, settingsRows, accIds, cps, cpIds, allTx, lockedThrough] = await Promise.all([
    s.list('accounts'), s.list('currencies'), s.list('countries'), s.list('appSettings'), s.listAccountIdentifiers(),
    s.list('counterparties'), s.list('counterpartyIdentifiers'), s.listTransactions(), getLockedThrough(ctx),
  ])
  void countries; void settingsRows
  const groups = groupResponses(review.responses)
  const primary: ResponseGroup | undefined = groups.find((g) => g.key === dec.primary && g.complete) ?? groups.find((g) => g.complete)
  const base: ImportReview = {
    job, aiName: primary?.aiName ?? null, statements: [], missingCards: [], cpGroups: [], own: [], identifierSuggestions: [],
    groups: groups.map((g) => ({ key: g.key, aiName: g.aiName, complete: g.complete, have: g.have, parts: g.parts, isPrimary: g === primary })),
    crossDiffs: null, blockers: [], canLoad: false,
  }
  if (!primary?.doc) { base.blockers.push(groups.length ? 'ответ неполный: не хватает частей' : 'ответ чата ещё не загружен'); return base }
  const doc: ImportDoc = primary.doc
  const other = groups.find((g) => g !== primary && g.complete && g.doc)
  base.crossDiffs = other?.doc ? crossCheck(doc, other.doc) : null

  const accById = new Map(accounts.map((a) => [a.id, a]))
  const cur = new Map(currencies.map((c) => [c.key, c.decimals]))
  const jobAccIds = new Set(job.accounts.map((a) => a.accountId))
  const jobAcc = new Map(job.accounts.map((a) => [a.accountId, a]))
  const cpByKey = new Map(cps.map((c) => [c.key, c]))
  const today = ctx.now().toISOString().slice(0, 10)
  const maskOwner = (mask: string): string | null => {
    const hit = accIds.filter((i) => i.last4 === mask && i.validFrom <= today && (!i.validTo || i.validTo >= today))
    return hit.length === 1 ? hit[0]!.accountId : null
  }

  // ---- проход 1: счета ----
  const maskToAccount = new Map<string, string>()
  const stm: ReviewStatement[] = doc.statements.map((st, i) => {
    const key = st.mask ?? st.accountKey ?? `#${i + 1}`
    const identified = st.mask ? maskOwner(st.mask) : null
    const byKey = st.accountKey ? accounts.find((a) => a.key === st.accountKey && jobAccIds.has(a.id)) : undefined
    const d: ImportAccountDecision | undefined = dec.accounts[key]
    let accountId: string | null = null
    let state: ReviewStatement['accountState'] = 'needs_decision'
    if (d === 'skip') state = 'skipped'
    else if (d) { accountId = d.accountId; state = 'confirmed' }
    else if (identified) { accountId = identified; state = 'identified' }
    const acc = accountId ? accById.get(accountId) : undefined
    const decimals = acc ? cur.get(acc.currencyKey) ?? 2 : 2
    if (accountId && st.mask) maskToAccount.set(st.mask, accountId)
    return {
      key, mask: st.mask, aiAccountKey: st.accountKey, accountId, proposedAccountId: identified ?? byKey?.id ?? null, accountState: state,
      bindMask: state === 'confirmed' && !!st.mask && st.mask !== (identified ? st.mask : ''), currencyKey: acc?.currencyKey ?? null, decimals,
      periodStart: st.periodStart, periodEnd: st.periodEnd, rowsInFile: st.rows.length, openingMinor: null, closingMinor: null, incomeMinor: 0, expenseMinor: 0,
      rows: [], errors: [], warnings: [], openingDiffMinor: null, openingFix: null, isFirstImport: false, entryDiffMinor: null, entryFix: null, entryAtUtc: null,
    }
  })

  // ---- проход 2: проверки по каждой карте ----
  const nameIds = cpIds.filter((i) => (i.kind === 'statement_name' || i.kind === 'name_pattern') && i.value && (!i.validTo || i.validTo >= today))
  const groupsMap = new Map<string, CpGroup>()
  const ownMap = new Map<string, OwnSuggestion>()
  const seenHash = new Set<string>()
  const matchedByName = new Set<string>()
  for (const t of allTx) if (t.dedupeHash) seenHash.add(t.dedupeHash)

  for (let i = 0; i < stm.length; i++) {
    const r = stm[i]!, st: ParsedStatement = doc.statements[i]!
    if (r.accountState === 'skipped' || r.accountState === 'needs_decision' || !r.accountId) continue
    const acc = accById.get(r.accountId)!
    const err = (code: string, text: string) => r.errors.push({ code, text })
    if (acc.archivedAt !== null || acc.trackingMode !== 'balance_and_movements') err('ACCOUNT_NOT_ALLOWED', `счёт «${acc.name}» в архиве или ведётся только по остаткам`)
    const tz = await accountTimeZone(ctx, acc)
    const dp = r.decimals
    const money = (m: number) => formatMinor(m, dp)
    if (st.currency && st.currency !== acc.currencyKey) err('CURRENCY_MISMATCH', `валюта выписки ${st.currency.toUpperCase()}, валюта счёта ${acc.currencyKey.toUpperCase()}`)

    // строки: разбор и сортировка (порядку чата не верим)
    const parsed: { row: ParsedRow; minor: number; utc: string }[] = []
    for (const row of st.rows) {
      try {
        const minor = parseMinor(row.amount, dp)
        const utc = localToUtc(row.bookedAt, tz)
        if (!utc) throw new Error('время')
        if (minor === 0) throw new Error('нулевая сумма')
        if (row.currency !== acc.currencyKey) err('CURRENCY_MISMATCH', `строка ${row.n}: валюта ${row.currency.toUpperCase()}`)
        parsed.push({ row, minor, utc })
      } catch { err('ROWS_UNPARSED', `строка ${row.n}: не разобрана сумма или время («${row.amount}», «${row.bookedAt}»)`) }
    }
    parsed.sort((a, b) => a.utc.localeCompare(b.utc) || a.row.n - b.row.n)
    if (st.rowsTotal !== null && st.rowsTotal !== st.rows.length) err('ROWS_UNPARSED', `чат заявил строк ${st.rowsTotal}, передал ${st.rows.length}`)
    const nums = st.rows.map((x) => x.n)
    if (new Set(nums).size !== nums.length) err('ROWS_UNPARSED', 'повторяющиеся номера строк')

    // цепочка остатков
    const bal = (x: string | null) => { if (x === null) return null; try { return parseMinor(x, dp) } catch { return null } }
    let opening = bal(st.opening)
    const withBal = parsed.length > 0 && parsed.every((p) => bal(p.row.balanceAfter) !== null)
    if (opening === null && withBal) opening = bal(parsed[0]!.row.balanceAfter)! - parsed[0]!.minor
    r.openingMinor = opening
    r.closingMinor = bal(st.closing)
    if (withBal && opening !== null) {
      let run = opening
      for (const p of parsed) {
        run += p.minor
        const after = bal(p.row.balanceAfter)!
        if (after !== run) { err('CHAIN_BREAK', `цепочка прерывается на строке ${p.row.n} (${p.row.bookedAt}): ожидался остаток ${money(run)}, в выписке ${money(after)}`); break }
      }
      const last = bal(parsed[parsed.length - 1]!.row.balanceAfter)
      if (r.closingMinor !== null && last !== null && last !== r.closingMinor) err('CLOSING_MISMATCH', `остаток на конец ${money(r.closingMinor)} не равен остатку после последней операции ${money(last)}`)
    } else if (parsed.length) r.warnings.push({ code: 'CHAIN_UNCHECKED', text: 'в выписке нет остатков после операций, цепочка не проверена' })
    r.incomeMinor = parsed.filter((p) => p.minor > 0).reduce((a, p) => a + p.minor, 0)
    r.expenseMinor = parsed.filter((p) => p.minor < 0).reduce((a, p) => a + p.minor, 0)
    const chatInc = bal(st.chatIncome), chatExp = bal(st.chatExpense)
    if ((chatInc !== null && chatInc !== r.incomeMinor) || (chatExp !== null && Math.abs(chatExp) !== Math.abs(r.expenseMinor))) r.warnings.push({ code: 'TOTALS_MISMATCH', text: 'итоги, названные чатом, не совпали с пересчётом приложения (использован пересчёт)' })
    if (r.closingMinor === null) r.warnings.push({ code: 'NO_CLOSING', text: 'нет остатка на конец выписки' })

    // строки: дубли, закрытые периоды, контрагенты
    const occ = new Map<string, number>()
    for (const p of parsed) {
      const base = `${p.utc}|${p.minor}|${p.row.currency}|${normName(p.row.description)}`
      const o = (occ.get(base) ?? 0) + 1; occ.set(base, o)
      const hash = await sha(rowDedupeKey(acc.id, p.utc, p.minor, p.row.currency, p.row.description, o))
      const accHashes = allTx.filter((t) => t.accountId === acc.id && t.dedupeHash === hash)
      const duplicate = accHashes.length > 0
      let origMinor: number | null = null
      let origCur: string | null = null
      if (p.row.original && (p.row.original.currency !== p.row.currency || p.row.original.amount.replace(/^-/, '') !== p.row.amount.replace(/^-/, ''))) {
        try {
          const v = Math.abs(parseMinor(p.row.original.amount, cur.get(p.row.original.currency) ?? 2))
          if (v !== 0) { origMinor = p.minor < 0 ? -v : v; origCur = p.row.original.currency }
        } catch { r.warnings.push({ code: 'ORIGINAL_IGNORED', text: `строка ${p.row.n}: исходная сумма не разобрана, пропущена` }) }
      }
      if (!duplicate && lockedThrough && localDateOf(Date.parse(p.utc), tz) <= lockedThrough) err('PERIOD_LOCKED', `строка ${p.row.n}: дата в закрытом периоде (по ${lockedThrough})`)

      // контрагент
      const text = normName(p.row.rawName ?? p.row.description)
      let counterpartyId: string | null = null
      let groupKey: string | null = null
      const chatCp = p.row.cpKey ? cpByKey.get(p.row.cpKey) : undefined
      const byName = nameIds.find((x) => x.kind === 'statement_name' ? normName(x.value!) === text : patternMatch(x.value!, text))
      if (chatCp) counterpartyId = chatCp.id
      else if (byName) { counterpartyId = byName.counterpartyId; matchedByName.add(byName.counterpartyId) }
      else if (p.row.linkedMask && p.row.linkedMask !== r.mask) {
        const target = maskToAccount.get(p.row.linkedMask) ?? maskOwner(p.row.linkedMask)
        const ownCp = target ? cps.find((c) => c.kind === 'own_account' && c.accountId === target) : undefined
        const o = ownMap.get(p.row.linkedMask) ?? { mask: p.row.linkedMask, accountId: target ?? '', counterpartyId: ownCp?.id ?? null, counterpartyName: ownCp?.name ?? null, count: 0, decision: dec.ownAccounts[p.row.linkedMask] ?? null }
        o.count++; ownMap.set(p.row.linkedMask, o)
        if (o.decision === true && ownCp) counterpartyId = ownCp.id
        if (!(o.decision === true && ownCp)) { groupKey = null }
        if (!counterpartyId && !ownCp) groupKey = text
      } else groupKey = text
      if (!counterpartyId && groupKey) {
        const g = groupsMap.get(groupKey) ?? { groupKey, rawName: p.row.rawName ?? p.row.description, count: 0, totalMinor: 0, decision: dec.counterparties[groupKey] ?? null, chatKey: p.row.cpKey }
        g.count++; g.totalMinor += p.minor; groupsMap.set(groupKey, g)
        const d = dec.counterparties[groupKey]
        if (d?.mode === 'existing') counterpartyId = d.counterpartyId
      }
      r.rows.push({ n: p.row.n, bookedAtUtc: p.utc, local: p.row.bookedAt, amountMinor: p.minor, description: p.row.description, originalMinor: origMinor, originalCurrency: origCur, duplicate, counterpartyId, groupKey, dedupeHash: hash, src: p.row })
    }
    const dups = r.rows.filter((x) => x.duplicate).length
    if (dups) r.warnings.push({ code: 'PERIOD_OVERLAP', text: `уже загружено ранее, будет пропущено строк: ${dups}` })

    // сверка с остатком в приложении на начало выписки
    if (r.rows.length && opening !== null) {
      const first = r.rows[0]!.bookedAtUtc
      const own = allTx.filter((t: Transaction) => t.accountId === acc.id)
      const calc = own.filter((t) => t.bookedAt < first).reduce((a, t) => a + t.amountMinor, 0)
      r.isFirstImport = own.length === 0
      if (calc !== opening) { r.openingDiffMinor = opening - calc; r.openingFix = dec.openingFix[r.key] ?? null }
    }
    // сверка с остатком, введённым владельцем
    const ja = jobAcc.get(acc.id)
    if (ja && r.rows.length) {
      const asOfDay = localDateOf(Date.parse(ja.asOf), tz)
      if (r.periodEnd && r.periodEnd < asOfDay && Date.parse(r.rows[r.rows.length - 1]!.bookedAtUtc) < Date.parse(ja.asOf)) {
        r.warnings.push({ code: 'NOT_COVERING_ENTRY_DATE', text: `выписка до ${r.periodEnd}, остаток владельца ${money(ja.balanceMinor)} на ${localDateOf(Date.parse(ja.asOf), tz)}: сверка пропущена` })
        if (r.closingMinor !== null && r.closingMinor !== ja.balanceMinor) r.warnings.push({ code: 'ENTRY_DIFF_INFO', text: `остаток на конец выписки ${money(r.closingMinor)}, введённый ${money(ja.balanceMinor)}: разница ${money(ja.balanceMinor - r.closingMinor)} объясняется движениями после выписки` })
      } else {
        const upTo = r.rows.filter((x) => x.bookedAtUtc <= ja.asOf)
        const expected = upTo.length ? bal(upTo[upTo.length - 1]!.src.balanceAfter) : opening
        if (expected !== null && expected !== ja.balanceMinor) { r.entryDiffMinor = ja.balanceMinor - expected; r.entryAtUtc = ja.asOf; r.entryFix = dec.entryFix[r.key] ?? null }
      }
    }
  }

  // ---- итоги ----
  for (const g of groupsMap.values()) base.cpGroups.push(g)
  base.cpGroups.sort((a, b) => b.count - a.count || a.rawName.localeCompare(b.rawName))
  base.own = [...ownMap.values()].sort((a, b) => a.mask.localeCompare(b.mask))
  for (const ni of doc.newIdentifiers) {
    const cp = cpByKey.get(ni.counterpartyKey) as Counterparty | undefined
    if (!cp || matchedByName.has(cp.id)) continue
    const id = `${cp.id}|${normName(ni.value)}`
    if (nameIds.some((x) => x.counterpartyId === cp.id && x.value && normName(x.value) === normName(ni.value))) continue
    if (!base.identifierSuggestions.some((x) => x.id === id)) base.identifierSuggestions.push({ id, counterpartyId: cp.id, counterpartyName: cp.name, value: ni.value, decision: dec.identifiers[id] ?? null })
  }
  base.statements = stm
  const present = new Set(stm.flatMap((x) => [x.accountId, x.proposedAccountId]))
  base.missingCards = job.accounts.filter((a) => !present.has(a.accountId)).map((a) => ({ accountId: a.accountId, name: accById.get(a.accountId)?.name ?? a.accountId }))

  const b = base.blockers
  for (const r of stm) {
    if (r.accountState === 'skipped') continue
    if (r.accountState === 'needs_decision') { b.push(`карта ${r.key}: не подтверждён счёт`); continue }
    for (const e of r.errors) b.push(`карта ${r.key}: ${e.text}`)
    if (r.openingDiffMinor !== null && !r.openingFix) b.push(`карта ${r.key}: остаток на начало не сходится, нужно решение`)
    if (r.entryDiffMinor !== null && !r.entryFix) b.push(`карта ${r.key}: остаток не сходится с введённым, нужно решение`)
  }
  if (!stm.some((r) => r.accountState !== 'skipped' && r.accountId)) b.push('нет карт для загрузки')
  base.canLoad = b.length === 0 && job.status === 'review'
  return base
}
export type { Account }
