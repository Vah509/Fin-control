// Приём ответа чата, решения владельца, загрузка в базу одним пакетом и откат (docs/IMPORT-DESIGN.md, раздел 3).
import type { ImportStoredResponse, Counterparty, CounterpartyIdentifier, ImportDecisions, ImportJob, ImportResult, Transaction } from '../data/types'
import { auditEntry } from './audit'
import { buildCheckpoint } from './checkpoints'
import type { CoreContext } from './context'
import { fail } from './errors'
import { addAccountIdentifier } from './identifiers'
import { analyzeImport, normName, readReview, type ImportReview } from './importReview'
import { extractJsonObjects, hashJson, validateImportDoc } from './importResponse'
import { makeKey } from './keys'
import { assertUnlocked } from './locks'
import { buildTransaction } from './transactions'

const owner = (ctx: CoreContext) => { if (!ctx.actor.isOwner) fail('FORBIDDEN', 'разбирать импорт может только владелец') }
async function job(ctx: CoreContext, id: string): Promise<ImportJob> {
  return (await ctx.storage.list('importJobs')).find((j) => j.id === id) ?? fail('NOT_FOUND', `задание ${id} не найдено`)
}
async function saveJob(ctx: CoreContext, j: ImportJob, audit?: ReturnType<typeof auditEntry>) {
  await ctx.storage.applyBatch({ put: { importJobs: [{ ...j, updatedAt: ctx.now().toISOString() }] }, audit: audit ? [audit] : [] })
}

/** Принимает текст ответа (блок кода, файл или несколько частей подряд). Возвращает число принятых JSON. */
export async function addImportResponse(ctx: CoreContext, jobId: string, text: string): Promise<number> {
  owner(ctx)
  const j = await job(ctx, jobId)
  if (j.status !== 'waiting_file' && j.status !== 'review') fail('INVALID_STATE', `в статусе «${j.status}» ответ загрузить нельзя`)
  const rv = readReview(j)
  const fresh: ImportStoredResponse[] = []
  for (const raw of extractJsonObjects(text)) {
    const doc = validateImportDoc(raw)
    if (doc.taskId !== j.id) fail('IMPORT_INVALID', 'task_id ответа не совпадает с заданием')
    if (doc.version !== j.contractVersion) fail('IMPORT_INVALID', `версия формата ${doc.version}, ожидается ${j.contractVersion}`)
    const id = await hashJson(raw)
    if (rv.responses.some((r) => r.id === id) || fresh.some((r) => r.id === id)) fail('IMPORT_DUPLICATE', 'этот ответ уже загружен')
    fresh.push({ id, receivedAt: ctx.now().toISOString(), doc: raw as never })
  }
  await saveJob(ctx, { ...j, status: 'review', review: { ...rv, responses: [...rv.responses, ...fresh] } },
    auditEntry(ctx, 'import_response_added', { tableName: 'import_jobs', recordId: j.id, details: { files: fresh.length } }))
  const back = (await ctx.storage.list('importJobs')).find((x) => x.id === j.id)
  if (readReview(back ?? j).responses.length < rv.responses.length + fresh.length)
    fail('IMPORT_INVALID', 'ответ не сохранился в базе: вероятно, не применена миграция 20261115200000_iteration6_import_review.sql (колонка import_jobs.review)')
  return fresh.length
}

/** Сохраняет решения владельца (целиком). */
export async function saveImportDecisions(ctx: CoreContext, jobId: string, decisions: ImportDecisions): Promise<void> {
  owner(ctx)
  const j = await job(ctx, jobId)
  if (j.status !== 'review') fail('INVALID_STATE', 'решения принимаются в статусе «разбор»')
  await saveJob(ctx, { ...j, review: { ...readReview(j), decisions } })
}

/** Сбросить загруженные ответы и вернуть задание в «ждёт файла». */
export async function resetImportResponses(ctx: CoreContext, jobId: string): Promise<void> {
  owner(ctx)
  const j = await job(ctx, jobId)
  if (j.status !== 'review') fail('INVALID_STATE', 'сбросить можно только задание в разборе')
  await saveJob(ctx, { ...j, status: 'waiting_file', review: {} }, auditEntry(ctx, 'import_responses_reset', { tableName: 'import_jobs', recordId: j.id }))
}

export async function loadImport(ctx: CoreContext, jobId: string): Promise<ImportResult> {
  owner(ctx)
  const rv: ImportReview = await analyzeImport(ctx, jobId)
  if (!rv.canLoad) fail('IMPORT_BLOCKED', rv.blockers.join('; ') || 'есть нерешённые вопросы', { blockers: rv.blockers })
  const j = rv.job
  const state = readReview(j)
  const dec = state.decisions
  const accounts = await ctx.storage.list('accounts')
  const cps = await ctx.storage.list('counterparties')
  const today = ctx.now().toISOString().slice(0, 10)
  const taken = new Set(cps.map((c) => c.key))
  const newCps: Counterparty[] = []
  const newIds: CounterpartyIdentifier[] = []
  const idOf = (cpId: string, value: string): CounterpartyIdentifier => ({ id: ctx.newId(), counterpartyId: cpId, kind: 'statement_name', value, valueHash: null, valueEnc: null, last4: null, validFrom: today, validTo: null })
  const groupCp = new Map<string, string>()
  for (const g of rv.cpGroups) {
    const d = g.decision
    if (d?.mode === 'new') {
      const key = makeKey(g.rawName, taken, 'counterparty'); taken.add(key)
      const c: Counterparty = { id: ctx.newId(), key, name: g.rawName, kind: 'organization', accountId: null, defaultTagId: null, defaultPlanType: null }
      newCps.push(c); newIds.push(idOf(c.id, g.rawName)); groupCp.set(g.groupKey, c.id)
    } else if (d?.mode === 'existing') newIds.push(idOf(d.counterpartyId, g.rawName))
  }
  for (const s of rv.identifierSuggestions) if (s.decision === 'add') newIds.push(idOf(s.counterpartyId, s.value))

  const txs: Transaction[] = []
  const notes: string[] = []
  let adjustments = 0, skipped = 0
  const checkpoints = []
  for (const st of rv.statements) {
    if (st.accountState === 'skipped' || !st.accountId) continue
    const acc = accounts.find((a) => a.id === st.accountId)!
    const first = st.rows[0]
    if (st.openingDiffMinor !== null && st.openingFix === 'adjust' && first) {
      txs.push(await buildTransaction(ctx, { accountId: acc.id, bookedAt: new Date(Date.parse(first.bookedAtUtc) - 1000).toISOString(), type: 'adjustment', amountMinor: st.openingDiffMinor, source: 'import', importId: j.id, isOpening: st.isFirstImport, comment: st.isFirstImport ? 'начальный остаток по выписке' : 'корректировка на начало выписки' }, acc))
      adjustments++
    }
    for (const r of st.rows) {
      if (r.duplicate) { skipped++; continue }
      txs.push(await buildTransaction(ctx, {
        accountId: acc.id, counterpartyId: r.counterpartyId ?? (r.groupKey ? groupCp.get(r.groupKey) ?? null : null), importId: j.id, source: 'import',
        bookedAt: r.bookedAtUtc, type: r.amountMinor > 0 ? 'income' : 'expense', amountMinor: r.amountMinor,
        originalAmountMinor: r.originalMinor, originalCurrencyKey: r.originalCurrency, dedupeHash: r.dedupeHash,
        raw: { n: r.n, description: r.description, bank_category: r.src.bankCategory, hints: r.src.hints, linked_mask: r.src.linkedMask },
      }, acc))
    }
    if (st.entryDiffMinor !== null && st.entryFix === 'adjust' && st.entryAtUtc) {
      txs.push(await buildTransaction(ctx, { accountId: acc.id, bookedAt: st.entryAtUtc, type: 'adjustment', amountMinor: st.entryDiffMinor, source: 'import', importId: j.id, comment: 'неучтённое по сверке с введённым остатком' }, acc))
      adjustments++
    }
    const last = st.rows[st.rows.length - 1]
    if (last && st.closingMinor !== null) {
      const cp = await buildCheckpoint(ctx, acc, { accountId: acc.id, asOf: last.bookedAtUtc, balanceMinor: st.closingMinor, source: 'statement', note: `выписка, задание ${j.id.slice(0, 8)}` })
      checkpoints.push(cp)
    }
  }
  const result: ImportResult = {
    loadedAt: ctx.now().toISOString(), transactions: txs.filter((t) => t.type !== 'adjustment').length, adjustments, checkpointIds: checkpoints.map((c) => c.id),
    newCounterparties: newCps.length, skippedDuplicates: skipped, notes, rolledBackAt: null,
  }
  const done: ImportJob = {
    ...j, status: 'loaded', updatedAt: ctx.now().toISOString(),
    review: { decisions: dec, result, responses: state.responses.map((r) => ({ id: r.id, receivedAt: r.receivedAt, doc: null })) },
  }
  await ctx.storage.applyBatch({
    put: { counterparties: newCps, counterpartyIdentifiers: newIds, transactions: txs, checkpoints, importJobs: [done] },
    audit: [auditEntry(ctx, 'import_loaded', { tableName: 'import_jobs', recordId: j.id, details: { transactions: result.transactions, adjustments, newCounterparties: newCps.length, skippedDuplicates: skipped } })],
  })
  // Привязка масок карт к счетам: после основной записи; сбой не отменяет загрузку.
  for (const st of rv.statements) {
    if (!st.bindMask || !st.accountId || !st.mask) continue
    if (!ctx.crypto) { notes.push(`маска ${st.mask} не привязана: ключи шифрования не загружены`); continue }
    try { await addAccountIdentifier(ctx, { accountId: st.accountId, kind: 'card_mask', value: st.mask }) } catch (e) { notes.push(`маска ${st.mask} не привязана: ${(e as Error).message}`) }
  }
  if (notes.length) await saveJob(ctx, { ...done, review: { ...done.review, result: { ...result, notes } } })
  return { ...result, notes }
}

/** Откат загруженного задания: операции помечаются на удаление, контрольные точки становятся ошибочными. Нужен незакрытый период. */
export async function rollbackImport(ctx: CoreContext, jobId: string): Promise<number> {
  owner(ctx)
  const j = await job(ctx, jobId)
  const rv = readReview(j)
  if (j.status !== 'loaded' || !rv.result || rv.result.rolledBackAt) fail('INVALID_STATE', 'откатить можно только загруженное задание')
  const accounts = new Map((await ctx.storage.list('accounts')).map((a) => [a.id, a]))
  const own = (await ctx.storage.listTransactions()).filter((t) => t.importId === j.id)
  const now = ctx.now().toISOString()
  for (const t of own) await assertUnlocked(ctx, accounts.get(t.accountId)!, t.bookedAt)
  const cps = (await ctx.storage.listCheckpoints()).filter((c) => rv.result!.checkpointIds.includes(c.id)).map((c) => ({ ...c, status: 'invalid' as const }))
  const next: ImportJob = { ...j, status: 'cancelled', updatedAt: now, review: { ...rv, result: { ...rv.result!, rolledBackAt: now } } }
  await ctx.storage.applyBatch({
    put: { transactions: own.map((t) => ({ ...t, deletedAt: now, updatedAt: now })), checkpoints: cps, importJobs: [next] },
    audit: [auditEntry(ctx, 'import_rolled_back', { tableName: 'import_jobs', recordId: j.id, details: { transactions: own.length } })],
  })
  return own.length
}
export { normName }
