import { describe, expect, it } from 'vitest'
import {
  addImportResponse, analyzeImport, createImportJob, loadImport, readReview, rollbackImport, saveImportDecisions,
} from '../src/core'
import type { Counterparty } from '../src/data/types'
import { code, ID, setup } from './helpers'

const row = (n: number, at: string, amount: string, after: string, name: string, extra: Record<string, unknown> = {}): Record<string, any> => ({
  n, booked_at: at, amount, currency: 'UAH', balance_after: after, description: name, bank_category: null,
  counterparty: { status: 'unknown', key: null, raw_name: name, candidates: [] }, linked_mask: null, hints: [], ...extra,
})
const doc = (taskId: string, rows: unknown[], over: Record<string, unknown> = {}, ai = 'Тест-ИИ') => ({
  format: 'fin-control-import', version: 1, task_id: taskId, prepared_at: '2026-11-09T10:00:00Z', part: 1, parts: 1, ai_name: ai,
  sources: [{ name: 'x.xlsx' }],
  statements: [{
    account: { key: 'mono', match: 'candidate', hints: { mask: '1111', currency: 'UAH' } }, period: { start: '2026-10-01', end: '2026-10-03' },
    opening_balance: '30.28', closing_balance: '100.00', totals: { income: '100.00', expense: '30.28' }, rows, checks: { chain: 'ok', rows_total: (rows as unknown[]).length, rows_listed: (rows as unknown[]).length },
    ...over,
  }],
  new_identifiers: [], issues: [],
})
const ROWS = () => [
  row(1, '2026-10-01T10:00:00', '-10.00', '20.28', 'Магазин А'),
  row(2, '2026-10-02T11:00:00', '100.00', '120.28', 'Людина Б', { original: { amount: '150.00', currency: 'UAH' }, hints: ['amount_differs:50.00'] }),
  row(3, '2026-10-03T12:00:00', '-20.28', '100.00', 'Магазин А'),
]
const block = (d: unknown) => 'Ось результат:\n```json\n' + JSON.stringify(d) + '\n```'

async function prepared(rows = ROWS()) {
  const t = await setup()
  const job = await createImportJob(t.ctx, { accounts: [{ accountId: ID.mono, balanceMinor: 10000, asOf: '2026-11-09T10:00:00.000Z' }] })
  await addImportResponse(t.ctx, job.id, block(doc(job.id, rows)))
  return { ...t, job }
}
const confirm = async (ctx: Parameters<typeof saveImportDecisions>[0], id: string, patch: (d: ReturnType<typeof readReview>['decisions']) => void) => {
  const j = (await ctx.storage.list('importJobs')).find((x) => x.id === id)!
  const d = readReview(j).decisions; patch(d); await saveImportDecisions(ctx, id, d)
}

describe('приём ответа', () => {
  it('отклоняет чужой task_id, не-JSON и повтор; принимает блок кода', async () => {
    const t = await setup()
    const job = await createImportJob(t.ctx, { accounts: [{ accountId: ID.mono, balanceMinor: 1, asOf: '2026-11-09T10:00:00.000Z' }] })
    expect(await code(addImportResponse(t.ctx, job.id, block(doc('другой', ROWS()))))).toBe('IMPORT_INVALID')
    expect(await code(addImportResponse(t.ctx, job.id, 'просто текст'))).toBe('IMPORT_INVALID')
    expect(await addImportResponse(t.ctx, job.id, block(doc(job.id, ROWS())))).toBe(1)
    expect((await t.storage.list('importJobs'))[0]!.status).toBe('review')
    expect(await code(addImportResponse(t.ctx, job.id, block(doc(job.id, ROWS()))))).toBe('IMPORT_DUPLICATE')
  })
  it('не владелец не может', async () => {
    const t = await setup({ owner: false })
    expect(await code(addImportResponse(t.ctx, 'x', '{}'))).toBe('FORBIDDEN')
  })
})

describe('разбор и загрузка', () => {
  it('первая загрузка: счёт и остаток на начало требуют решений, затем загрузка сходится с выпиской', async () => {
    const { ctx, job } = await prepared()
    let rv = await analyzeImport(ctx, job.id)
    expect(rv.canLoad).toBe(false)
    expect(rv.statements[0]!.accountState).toBe('needs_decision')
    expect(rv.statements[0]!.proposedAccountId).toBe(ID.mono)
    expect(rv.statements[0]!.rowsInFile).toBe(3)
    expect(rv.missingCards).toEqual([])
    expect(await code(loadImport(ctx, job.id))).toBe('IMPORT_BLOCKED')
    await confirm(ctx, job.id, (d) => { d.accounts['1111'] = { accountId: ID.mono } })
    rv = await analyzeImport(ctx, job.id)
    const st = rv.statements[0]!
    expect(st.errors).toEqual([])
    expect(st.openingDiffMinor).toBe(3028)
    expect(st.isFirstImport).toBe(true)
    expect(rv.canLoad).toBe(false)
    await confirm(ctx, job.id, (d) => { d.openingFix['1111'] = 'adjust' })
    expect((await analyzeImport(ctx, job.id)).canLoad).toBe(true)
    const res = await loadImport(ctx, job.id)
    expect(res.transactions).toBe(3)
    expect(res.adjustments).toBe(1)
    const txs = await ctx.storage.listTransactions({ accountId: ID.mono })
    expect(txs.reduce((s, t) => s + t.amountMinor, 0)).toBe(10000)
    expect(txs.filter((t) => t.isOpening)).toHaveLength(1)
    expect(txs.find((t) => t.amountMinor === 10000)!.originalAmountMinor).toBe(15000)
    expect(txs.every((t) => t.importId === job.id)).toBe(true)
    const cp = await ctx.storage.listCheckpoints({ accountIds: [ID.mono] })
    expect(cp).toHaveLength(1)
    expect(cp[0]!.balanceMinor).toBe(10000)
    const j = (await ctx.storage.list('importJobs'))[0]!
    expect(j.status).toBe('loaded')
    expect(readReview(j).responses.every((r) => r.doc === null)).toBe(true)
  })

  it('повторная выписка тех же строк: всё пропускается как дубли', async () => {
    const { ctx, job } = await prepared()
    await confirm(ctx, job.id, (d) => { d.accounts['1111'] = { accountId: ID.mono }; d.openingFix['1111'] = 'adjust' })
    await loadImport(ctx, job.id)
    const job2 = await createImportJob(ctx, { accounts: [{ accountId: ID.mono, balanceMinor: 10000, asOf: '2026-11-09T11:00:00.000Z' }] })
    await addImportResponse(ctx, job2.id, block(doc(job2.id, ROWS())))
    await confirm(ctx, job2.id, (d) => { d.accounts['1111'] = { accountId: ID.mono } })
    const rv = await analyzeImport(ctx, job2.id)
    expect(rv.statements[0]!.rows.every((r) => r.duplicate)).toBe(true)
    expect(rv.statements[0]!.openingDiffMinor).toBeNull()
    const res = await loadImport(ctx, job2.id)
    expect(res.transactions).toBe(0)
    expect(res.skippedDuplicates).toBe(3)
  })

  it('ловит разрыв цепочки, неверный остаток на конец, чужой порядок строк и число строк', async () => {
    const rows = ROWS(); rows[1]!.balance_after = '999.00'
    const { ctx, job } = await prepared(rows)
    await confirm(ctx, job.id, (d) => { d.accounts['1111'] = { accountId: ID.mono }; d.openingFix['1111'] = 'adjust' })
    const rv = await analyzeImport(ctx, job.id)
    expect(rv.statements[0]!.errors.map((e) => e.code)).toContain('CHAIN_BREAK')
    expect(rv.canLoad).toBe(false)
    // порядок «новые сверху» не мешает
    const t = await prepared([...ROWS()].reverse())
    await confirm(t.ctx, t.job.id, (d) => { d.accounts['1111'] = { accountId: ID.mono } })
    expect((await analyzeImport(t.ctx, t.job.id)).statements[0]!.errors).toEqual([])
    // число строк
    const u = await setup()
    const j = await createImportJob(u.ctx, { accounts: [{ accountId: ID.mono, balanceMinor: 1, asOf: '2026-11-09T10:00:00.000Z' }] })
    await addImportResponse(u.ctx, j.id, block(doc(j.id, ROWS(), { checks: { rows_total: 5 } })))
    await confirm(u.ctx, j.id, (d) => { d.accounts['1111'] = { accountId: ID.mono } })
    expect((await analyzeImport(u.ctx, j.id)).statements[0]!.errors.some((e) => e.code === 'ROWS_UNPARSED')).toBe(true)
  })

  it('контрагенты: ключ счёта от чата игнорируется, группы по названию, решения применяются', async () => {
    const rows = ROWS(); rows[0]!.counterparty = { status: 'matched', key: 'mono', raw_name: 'Магазин А', candidates: [] }
    const { ctx, job, storage } = await prepared(rows)
    await confirm(ctx, job.id, (d) => { d.accounts['1111'] = { accountId: ID.mono }; d.openingFix['1111'] = 'adjust' })
    let rv = await analyzeImport(ctx, job.id)
    expect(rv.cpGroups.map((g) => [g.rawName, g.count])).toEqual([['Магазин А', 2], ['Людина Б', 1]])
    const existing: Counterparty = { id: 'cp-b', key: 'b', name: 'Б', kind: 'person', accountId: null, defaultTagId: null, defaultPlanType: null }
    await storage.applyBatch({ put: { counterparties: [existing] } })
    await confirm(ctx, job.id, (d) => { d.counterparties['магазин а'] = { mode: 'new' }; d.counterparties['людина б'] = { mode: 'existing', counterpartyId: 'cp-b' } })
    rv = await analyzeImport(ctx, job.id)
    expect(rv.canLoad).toBe(true)
    const res = await loadImport(ctx, job.id)
    expect(res.newCounterparties).toBe(1)
    const txs = await ctx.storage.listTransactions({ accountId: ID.mono })
    const shop = (await ctx.storage.list('counterparties')).find((c) => c.name === 'Магазин А')!
    expect(txs.filter((t) => t.counterpartyId === shop.id)).toHaveLength(2)
    expect(txs.filter((t) => t.counterpartyId === 'cp-b')).toHaveLength(1)
    const ids = await ctx.storage.list('counterpartyIdentifiers')
    expect(ids.map((i) => i.value).sort()).toEqual(['Людина Б', 'Магазин А'])
    // тот же контрагент узнаётся по названию в следующий раз
    const j2 = await createImportJob(ctx, { accounts: [{ accountId: ID.mono, balanceMinor: 0, asOf: '2026-11-10T10:00:00.000Z' }] })
    await addImportResponse(ctx, j2.id, block(doc(j2.id, [row(1, '2026-10-05T10:00:00', '-1.00', '99.00', 'магазин  а')], { opening_balance: '100.00', closing_balance: '99.00' })))
    await confirm(ctx, j2.id, (d) => { d.accounts['1111'] = { accountId: ID.mono } })
    expect((await analyzeImport(ctx, j2.id)).cpGroups).toEqual([])
  })

  it('«свой счёт» по linked_mask предлагается и подтверждается', async () => {
    const rows = ROWS(); rows[0]!.linked_mask = '2222'
    const { ctx, job, storage } = await prepared(rows)
    await storage.applyBatch({ put: { counterparties: [{ id: 'cp-own', key: 'own-space', name: 'Свой SPACE', kind: 'own_account', accountId: ID.space, defaultTagId: null, defaultPlanType: null }] } })
    const space = (await storage.list('accounts')).find((a) => a.id === ID.space)!
    expect(space).toBeTruthy()
    await storage.applyBatch({ put: { accountIdentifiers: [{ id: 'i1', accountId: ID.space, kind: 'card_mask', valueHash: 'h', valueEnc: 'e', last4: '2222', validFrom: '2020-01-01', validTo: null }] } })
    await confirm(ctx, job.id, (d) => { d.accounts['1111'] = { accountId: ID.mono }; d.openingFix['1111'] = 'adjust'; d.ownAccounts['2222'] = true })
    const rv = await analyzeImport(ctx, job.id)
    expect(rv.own[0]).toMatchObject({ mask: '2222', counterpartyId: 'cp-own', decision: true })
    await loadImport(ctx, job.id)
    expect((await ctx.storage.listTransactions({ accountId: ID.mono })).filter((t) => t.counterpartyId === 'cp-own')).toHaveLength(1)
  })

  it('сверка двух чатов показывает различия', async () => {
    const { ctx, job } = await prepared()
    const other = ROWS(); other[2]!.amount = '-20.00'
    await addImportResponse(ctx, job.id, block(doc(job.id, other, {}, 'Второй ИИ')))
    const rv = await analyzeImport(ctx, job.id)
    expect(rv.groups).toHaveLength(2)
    expect(rv.aiName).toBe('Тест-ИИ')
    expect(rv.crossDiffs!.length).toBeGreaterThan(0)
  })

  it('части ответа склеиваются, неполный набор не принимается к разбору', async () => {
    const t = await setup()
    const job = await createImportJob(t.ctx, { accounts: [{ accountId: ID.mono, balanceMinor: 1, asOf: '2026-11-09T10:00:00.000Z' }] })
    const p1 = { ...doc(job.id, ROWS().slice(0, 2), { closing_balance: '120.28', checks: { rows_total: 2 } }), part: 1, parts: 2 }
    const p2 = { ...doc(job.id, ROWS().slice(2), { opening_balance: null, checks: { rows_total: 1 } }), part: 2, parts: 2 }
    await addImportResponse(t.ctx, job.id, block(p1))
    expect((await analyzeImport(t.ctx, job.id)).blockers[0]).toContain('неполный')
    await addImportResponse(t.ctx, job.id, block(p2))
    await confirm(t.ctx, job.id, (d) => { d.accounts['1111'] = { accountId: ID.mono } })
    const rv = await analyzeImport(t.ctx, job.id)
    expect(rv.statements[0]!.rows).toHaveLength(3)
  })

  it('откат помечает операции на удаление; закрытый период откат блокирует', async () => {
    const { ctx, job } = await prepared()
    await confirm(ctx, job.id, (d) => { d.accounts['1111'] = { accountId: ID.mono }; d.openingFix['1111'] = 'adjust' })
    await loadImport(ctx, job.id)
    expect(await rollbackImport(ctx, job.id)).toBe(4)
    expect(await ctx.storage.listTransactions({ accountId: ID.mono })).toHaveLength(0)
    expect((await ctx.storage.list('importJobs'))[0]!.status).toBe('cancelled')
    expect((await ctx.storage.listCheckpoints())[0]!.status).toBe('invalid')
  })

  it('закрытый период блокирует загрузку', async () => {
    const { ctx, job, storage } = await prepared()
    await storage.applyBatch({ put: { periodLocks: [{ id: 'l1', seq: 1, projectId: null, lockedThrough: '2026-10-02', lockedAt: '2026-11-01T00:00:00Z', lockedBy: null, status: 'active', releasedAt: null, releasedBy: null, releaseReason: null }] } })
    await confirm(ctx, job.id, (d) => { d.accounts['1111'] = { accountId: ID.mono }; d.openingFix['1111'] = 'adjust' })
    const rv = await analyzeImport(ctx, job.id)
    expect(rv.statements[0]!.errors.some((e) => e.code === 'PERIOD_LOCKED')).toBe(true)
    expect(rv.canLoad).toBe(false)
  })

  it('выписка, дошедшая до даты ввода, но не сходящаяся с введённым остатком, требует решения', async () => {
    const t = await setup()
    const job = await createImportJob(t.ctx, { accounts: [{ accountId: ID.mono, balanceMinor: 9000, asOf: '2026-10-03T20:00:00.000Z' }] })
    await addImportResponse(t.ctx, job.id, block(doc(job.id, ROWS())))
    await confirm(t.ctx, job.id, (d) => { d.accounts['1111'] = { accountId: ID.mono }; d.openingFix['1111'] = 'adjust' })
    let rv = await analyzeImport(t.ctx, job.id)
    expect(rv.statements[0]!.entryDiffMinor).toBe(-1000)
    expect(rv.canLoad).toBe(false)
    await confirm(t.ctx, job.id, (d) => { d.entryFix['1111'] = 'adjust' })
    rv = await analyzeImport(t.ctx, job.id)
    expect(rv.canLoad).toBe(true)
    await loadImport(t.ctx, job.id)
    expect((await t.ctx.storage.listTransactions({ accountId: ID.mono })).reduce((s, x) => s + x.amountMinor, 0)).toBe(9000)
  })
})
