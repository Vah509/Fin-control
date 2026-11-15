// Задания на импорт выписок: создание, пакет для ИИ-чата, отмена. Этап Б-1 (docs/IMPORT-DESIGN.md).
// Разбор ответа чата и загрузка в базу будут в следующих пунктах CURRENT-TASK.
import type {
  Account, AccountIdentifier, Counterparty, CounterpartyIdentifier, ImportJob, ImportJobAccount, Institution,
} from '../data/types'
import { auditEntry } from './audit'
import type { CoreContext } from './context'
import { fail } from './errors'
import { assertMinor, formatMinor } from './money'
import { readSettings, resolveTimeZone } from './settings'
import { addDays, localDateOf, normalizeIso } from './time'

export const IMPORT_CONTRACT_VERSION = 1
/** Если контрагентов больше, в пакет идут использованные на выбранных счетах за 12 месяцев и все «свои счета». */
export const MAX_COUNTERPARTIES_ALL = 300

const OPEN: ImportJob['status'][] = ['preparing', 'waiting_file']

/** Счета, которые можно выбрать для импорта: не архивные и в режиме «остатки и движения». */
export async function listImportableAccounts(ctx: CoreContext): Promise<Account[]> {
  const accounts = await ctx.storage.list('accounts')
  return accounts
    .filter((a) => a.archivedAt === null && a.trackingMode === 'balance_and_movements')
    .sort((a, b) => a.sortOrder - b.sortOrder || a.key.localeCompare(b.key))
}

/** Задания, новые сверху. */
export async function listImportJobs(ctx: CoreContext): Promise<ImportJob[]> {
  const jobs = await ctx.storage.list('importJobs')
  return jobs.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt) || b.id.localeCompare(a.id))
}

export async function getImportJob(ctx: CoreContext, id: string): Promise<ImportJob> {
  const job = (await ctx.storage.list('importJobs')).find((j) => j.id === id)
  return job ?? fail('NOT_FOUND', `задание ${id} не найдено`)
}

export interface NewImportJobInput {
  /** Выбранные счета; остаток и момент, на который владелец его видит в банке. */
  accounts: { accountId: string; balanceMinor: number; asOf: string }[]
}

/** Создаёт задание: проверяет счета и остатки, строит пакет, пишет всё одним пакетом записей. Статус «ждёт файла». */
export async function createImportJob(ctx: CoreContext, input: NewImportJobInput): Promise<ImportJob> {
  if (!ctx.actor.isOwner) fail('FORBIDDEN', 'готовить задания на импорт может только владелец')
  if (input.accounts.length === 0) fail('INVALID_FIELD', 'выберите хотя бы один счёт')
  const ids = input.accounts.map((a) => a.accountId)
  if (new Set(ids).size !== ids.length) fail('INVALID_FIELD', 'счёт выбран дважды')

  const allowed = new Map((await listImportableAccounts(ctx)).map((a) => [a.id, a]))
  const all = await ctx.storage.list('accounts')
  const chosen: ImportJobAccount[] = input.accounts.map((a) => {
    const acc = allowed.get(a.accountId)
    if (!acc) {
      const known = all.find((x) => x.id === a.accountId)
      if (!known) return fail('NOT_FOUND', `счёт ${a.accountId} не найден`)
      if (known.archivedAt !== null) return fail('ACCOUNT_ARCHIVED', `счёт «${known.name}» в архиве`)
      return fail('INVALID_FIELD', `счёт «${known.name}» ведётся только по остаткам, импорт движений для него не нужен`)
    }
    return { accountId: a.accountId, balanceMinor: assertMinor(a.balanceMinor, `остаток счёта «${acc.name}»`), asOf: normalizeIso(a.asOf, `дата остатка счёта «${acc.name}»`) }
  })

  const id = ctx.newId()
  const nowIso = ctx.now().toISOString()
  const packageText = await buildImportPackage(ctx, { taskId: id, accounts: chosen })
  const job: ImportJob = {
    id, status: 'waiting_file', accounts: chosen, packageText, contractVersion: IMPORT_CONTRACT_VERSION,
    createdBy: ctx.actor.userId, createdAt: nowIso, updatedAt: nowIso,
  }
  await ctx.storage.applyBatch({
    put: { importJobs: [job] },
    audit: [auditEntry(ctx, 'import_job_created', {
      tableName: 'import_jobs', recordId: id, details: { accounts: chosen.length, contractVersion: IMPORT_CONTRACT_VERSION },
    })],
  })
  return job
}

/** Отмена: только пока файл ответа не загружен (подготовка, ждёт файла). */
export async function cancelImportJob(ctx: CoreContext, id: string): Promise<ImportJob> {
  if (!ctx.actor.isOwner) fail('FORBIDDEN', 'отменять задания может только владелец')
  const job = await getImportJob(ctx, id)
  if (!OPEN.includes(job.status)) fail('INVALID_STATE', `задание в статусе «${job.status}» отменить нельзя`)
  const next: ImportJob = { ...job, status: 'cancelled', updatedAt: ctx.now().toISOString() }
  await ctx.storage.applyBatch({
    put: { importJobs: [next] },
    audit: [auditEntry(ctx, 'import_job_cancelled', { tableName: 'import_jobs', recordId: id, oldData: job.status, newData: 'cancelled' })],
  })
  return next
}

// ---------- пакет ----------

const json = (v: unknown) => JSON.stringify(v)

/** Короткое описание признаков опознания: только последние 4 знака, полных номеров нет. */
function maskList(ids: AccountIdentifier[]) {
  return ids.filter((i) => i.last4).map((i) => ({ kind: i.kind, last4: i.last4, from: i.validFrom, to: i.validTo }))
}

function cpLine(c: Counterparty, accKey: Map<string, string>, ids: CounterpartyIdentifier[], today: string) {
  const names = ids
    .filter((i) => i.counterpartyId === c.id && (i.kind === 'statement_name' || i.kind === 'name_pattern') && i.value && (!i.validTo || i.validTo >= today))
    .map((i) => (i.kind === 'name_pattern' ? { pattern: i.value } : i.value))
  const o: Record<string, unknown> = { key: c.key, name: c.name, kind: c.kind }
  if (c.accountId && accKey.get(c.accountId)) o['account'] = accKey.get(c.accountId)
  if (names.length) o['names'] = names
  return o
}

export interface PackageInput { taskId: string; accounts: ImportJobAccount[] }

/** Строит текст пакета (.md) из текущей базы. Выписки к чату прикладываются отдельно. */
export async function buildImportPackage(ctx: CoreContext, input: PackageInput): Promise<string> {
  const s = ctx.storage
  const [accounts, institutions, projects, countries, currencies, settingsRows, identifiers, counterparties, cpIdentifiers] = await Promise.all([
    s.list('accounts'), s.list('institutions'), s.list('projects'), s.list('countries'), s.list('currencies'),
    s.list('appSettings'), s.listAccountIdentifiers(), s.list('counterparties'), s.list('counterpartyIdentifiers'),
  ])
  const settings = readSettings(settingsRows)
  const now = ctx.now()
  const prepared = now.toISOString()
  const today = prepared.slice(0, 10)
  const inst = new Map<string, Institution>(institutions.map((i) => [i.id, i]))
  const proj = new Map(projects.map((p) => [p.id, p.key]))
  const dec = new Map(currencies.map((c) => [c.key, c.decimals]))
  const accKey = new Map(accounts.map((a) => [a.id, a.key]))
  const selectedIds = new Set(input.accounts.map((a) => a.accountId))
  const active = accounts.filter((a) => a.archivedAt === null).sort((a, b) => a.sortOrder - b.sortOrder || a.key.localeCompare(b.key))

  const txs = await s.listTransactions({ accountIds: [...selectedIds] })
  const money = (minor: number, cur: string) => formatMinor(minor, dec.get(cur) ?? 2)

  const chosen = input.accounts.map((ja) => {
    const a = accounts.find((x) => x.id === ja.accountId) ?? fail('NOT_FOUND', `счёт ${ja.accountId} не найден`)
    const tz = resolveTimeZone(a, countries, settings)
    const own = txs.filter((t) => t.accountId === a.id)
    const last = own.reduce<string | null>((m, t) => (m === null || t.bookedAt > m ? t.bookedAt : m), null)
    const calc = own.reduce((sum, t) => sum + t.amountMinor, 0)
    return {
      key: a.key, name: a.name, type: a.type, institution: a.institutionId ? inst.get(a.institutionId)?.key ?? null : null,
      holder: a.holder, project: proj.get(a.projectId) ?? null, currency: a.currencyKey.toUpperCase(), country: a.countryKey, timezone: tz,
      identifiers: maskList(identifiers.filter((i) => i.accountId === a.id)),
      app: { last_operation_at_local: last ? localIso(last, tz) : null, calculated_balance_now: money(calc, a.currencyKey) },
      entered_by_owner: { balance: money(ja.balanceMinor, a.currencyKey), as_of_utc: ja.asOf, as_of_local: localIso(ja.asOf, tz) },
    }
  })

  const others = active.filter((a) => !selectedIds.has(a.id)).map((a) => ({
    key: a.key, name: a.name, institution: a.institutionId ? inst.get(a.institutionId)?.key ?? null : null, currency: a.currencyKey.toUpperCase(),
    last4: identifiers.filter((i) => i.accountId === a.id && i.last4).map((i) => i.last4),
  }))

  let cps = counterparties
  let cpNote = 'все контрагенты'
  if (cps.length > MAX_COUNTERPARTIES_ALL) {
    const from = `${addDays(today, -365)}T00:00:00.000Z`
    const used = new Set((await s.listTransactions({ accountIds: [...selectedIds], bookedFrom: from })).map((t) => t.counterpartyId).filter((x): x is string => !!x))
    cps = cps.filter((c) => used.has(c.id) || c.kind === 'own_account')
    cpNote = `список сокращён: использованные на выбранных счетах за 12 месяцев и все «свои счета» (всего в базе ${counterparties.length})`
  }
  const cpRows = cps.sort((a, b) => a.key.localeCompare(b.key)).map((c) => cpLine(c, accKey, cpIdentifiers, today))

  return [
    `# Задание на разбор выписки Fin-control`,
    ``,
    `task_id: ${input.taskId}`,
    `contract_version: ${IMPORT_CONTRACT_VERSION}`,
    `prepared_at: ${prepared}`,
    ``,
    INSTRUCTIONS,
    ``,
    `## Формат ответа`,
    ``,
    RESPONSE_FORMAT,
    ``,
    `## Каталог расхождений (коды для issues)`,
    ``,
    ISSUE_CODES,
    ``,
    `## Выбранные счета (описаны полностью)`,
    `Время в этом файле локальное, в поясе счёта (поле timezone). entered_by_owner: остаток, который владелец увидел в банке на момент as_of.`,
    ``,
    '```json',
    JSON.stringify(chosen, null, 1),
    '```',
    ``,
    `## Остальные активные счета (коротко, чтобы узнавать маски карт)`,
    ``,
    '```json',
    json(others),
    '```',
    ``,
    `## Контрагенты (${cpNote}; names: названия в выписке)`,
    ``,
    '```json',
    cpRows.map(json).join('\n'),
    '```',
    ``,
  ].join('\n')
}

/** ISO UTC -> местное время счёта 'YYYY-MM-DDTHH:MM:SS' (без пояса). */
function localIso(isoUtc: string, tz: string): string {
  const ms = Date.parse(isoUtc)
  const date = localDateOf(ms, tz)
  const t = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).format(new Date(ms))
  return `${date}T${t}`
}

const INSTRUCTIONS = `## Инструкция для ИИ-чата
Ты разбираешь банковскую выписку для приложения учёта денег. К этому файлу приложены одна или несколько выписок (xlsx, pdf или csv). Верни результат одним JSON по формату ниже. Правила:
1. Ответ только JSON в блоке кода, без пояснений вокруг. Если не помещается, делай части: поля part и parts, одинаковый task_id, каждая часть полный JSON.
2. В ответ обязательно положи task_id из этого файла без изменений.
3. Каждая строка выписки попадает в rows: ничего не пропускай и не объединяй. Если строку не удалось разобрать, добавь issue ROWS_UNPARSED.
4. Тип строки определяется знаком суммы: расход отрицательный, приход положительный. Переводы между своими счетами тоже расход и приход, их не склеивай.
5. Суммы строками с точкой, без пробелов. Время локальное, как в выписке, формат ГГГГ-ММ-ДДTЧЧ:ММ:СС. Период, остатки на начало и конец берутся из шапки выписки.
6. Счёт определи по маске карты или номеру из шапки и списка счетов ниже. match: exact (признак совпал), candidate (похоже, но признак другой), none. Не угадывай: сомнение отражай в issues.
7. Контрагента сопоставь по названиям (names) из списка. status: matched (точное), suggested (похожее, укажи кандидатов), new (новое название), unknown (не определить). Не придумывай ключи.
8. Не выводи паспортные и налоговые номера, адреса, полные номера счетов контрагентов. Из описания их убирай.
9. Арифметику цепочки остатков проверяй, но сомнения отдавай в issues, а не исправляй данные.
10. Не пересчитывай и не меняй суммы. Если банк даёт остаток после операции, клади его в balance_after.\n11. Одна карта (маска) = один элемент statements, даже если в нём одна строка. Строки разных карт не смешивай; карту, у которой в выписке есть операции, не пропускай.\n12. Строки в rows по времени от старых к новым, n с 1 в этом порядке. Если у карты нет сводки, opening_balance = balance_after первой операции минус её сумма, closing_balance = balance_after последней; добавь в hints строки статуса \"opening_derived\".\n13. Если сумма по счёту отличается от суммы операции в той же валюте (комиссия банка не отдельной строкой), добавь в hints строки \"amount_differs:<разница>\", например \"amount_differs:50.00\". Строку не дели.\n14. counterparty.key только из списка контрагентов ниже. Ключ счёта (account key) в counterparty.key не кладут никогда. Если в описании маска другой карты («на свою картку *4402»), положи её в linked_mask, status оставь unknown и добавь issue CP_OWN_ACCOUNT_SUGGESTED.\n15. issue.ref для строки: «маска:n», например «0444:15»; для счёта и контрагента: ключ или название. Каждое NOT_COVERING_ENTRY_DATE и каждое сомнение отдавай отдельным issue.\n16. match: exact только если признак карты есть в identifiers счёта выше; если список признаков пуст, а маска встречается лишь в названии счёта, ставь candidate.`

const RESPONSE_FORMAT = '```json\n' + JSON.stringify({
  format: 'fin-control-import', version: 1, task_id: '<task_id>', prepared_at: '<prepared_at>', part: 1, parts: 1,
  sources: [{ name: 'имя файла выписки' }],
  statements: [{
    account: { key: 'ключ счёта или null', match: 'exact | candidate | none', hints: { mask: '0444', number_tail: null, currency: 'UAH', name: null } },
    period: { start: 'ГГГГ-ММ-ДД', end: 'ГГГГ-ММ-ДД' },
    opening_balance: '30.28', closing_balance: '701.26', totals: { income: '0.00', expense: '0.00' },
    rows: [{
      n: 1, booked_at: '2026-10-25T15:41:45', amount: '-22050.00', currency: 'UAH',
      original: { amount: '22050.00', currency: 'UAH' }, balance_after: '701.26', description: 'текст операции', bank_category: null,
      counterparty: { status: 'matched | suggested | new | unknown', key: null, raw_name: 'название в выписке', candidates: [] },
      linked_mask: null, hints: [],
    }],
    checks: { chain: 'ok | broken', rows_total: 1, rows_listed: 1 },
  }],
  new_identifiers: [{ counterparty_key: 'ключ', kind: 'statement_name', value: 'название' }],
  issues: [{ code: 'КОД', scope: 'statement | row | counterparty | account', ref: 'n или key', details: {}, suggested_actions: [] }],
}, null, 1) + '\n```\nПоле original заполняй, только если валюта или сумма операции отличаются от суммы по счёту. new_identifiers: новые названия известных контрагентов.'

const ISSUE_CODES = `ACCOUNT_UNKNOWN, ACCOUNT_IDENTIFIER_CHANGED, CURRENCY_MISMATCH, OPENING_MISMATCH, PERIOD_GAP, PERIOD_OVERLAP, CHAIN_BREAK, CLOSING_MISMATCH, ENTRY_BALANCE_MISMATCH (выписка доходит до as_of и не сходится с entered_by_owner), NOT_COVERING_ENTRY_DATE (выписка кончается раньше as_of), ROWS_UNPARSED, CP_NEW, CP_UNKNOWN, CP_AMBIGUOUS, CP_OWN_ACCOUNT_SUGGESTED (маска в описании совпала со счётом из списка), IDENTIFIER_SUGGESTED. Решения принимает владелец в приложении, ты только сообщаешь.`
