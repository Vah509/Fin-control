import { describe, expect, it } from 'vitest'
import { parseSlspStatement } from '../../src/core/statements'
import { compareTask, createStatementTask, finishStatementTask, listTaskProblems, resolveProblem, saveComparison } from '../../src/core'
import type { Counterparty, Transaction } from '../../src/data/types'
import { ID, setup } from '../helpers'
import { buildSlsp } from './slspFixture'

const stmt = (tamper = false) => parseSlspStatement(buildSlsp({
  opening: '1 000,00', deposits: '500,00', withdrawals: '- 30,00', closing: tamper ? '1 471,00' : '1 470,00',
  pages: [[
    { dates: '03.09.2026 03.09.2026', lines: ['Platba kartou', 'Č. k. 1111 22** **** 3333', 'Shop A-BRATISLAVA 01. 09. 2026 10:00:00', 'Transakcia prostredníctvom GooglePay'], amount: '- 10,00', balance: '990,00' },
    { dates: '05.09.2026 05.09.2026', lines: ['Platba kartou', 'Č. k. 1111 22** **** 3333', 'Shop B-BRATISLAVA 03. 09. 2026 12:00:00', 'Transakcia prostredníctvom GooglePay'], amount: '- 20,00', balance: '970,00' },
    { dates: '06.09.2026 06.09.2026', lines: ['Prijatá SEPA platba', 'SK00 0000 0000 0000 0000 0002 BIC: TESTSKBX', 'Názov protiúčtu: Test Sender'], amount: '500,00', balance: '1 470,00' },
  ]],
}))
const tx = (id: string, date: string, amountMinor: number): Transaction => ({
  id, accountId: ID.space, counterpartyId: null, importId: null, source: 'manual', bookedAt: `${date}T10:00:00.000Z`, type: amountMinor > 0 ? 'income' : 'expense',
  amountMinor, currencyKey: 'eur', originalAmountMinor: null, originalCurrencyKey: null, tagId: null, planType: null, comment: null,
  transferId: null, dedupeHash: null, deletedAt: null, isOpening: false, raw: null, createdBy: null, createdAt: '2026-11-01T00:00:00.000Z', updatedAt: '2026-11-01T00:00:00.000Z',
})
async function prepared(opts: { identifier?: boolean; txs?: Transaction[]; senderAccountId?: string | null; tamper?: boolean } = {}) {
  const t = await setup({ withCrypto: true })
  const st = stmt(opts.tamper)
  const put: Record<string, unknown[]> = { transactions: opts.txs ?? [] }
  if (opts.identifier !== false) put.accountIdentifiers = [{ id: 'i1', accountId: ID.space, kind: 'account_number', valueHash: 'h', valueEnc: 'e', last4: st.accounts[0]!.key, validFrom: '2020-01-01', validTo: null }]
  if (opts.senderAccountId !== undefined) {
    const cp: Counterparty = { id: 'cp-own', key: 'own', name: 'Свой: Test Sender', kind: 'own_account', accountId: opts.senderAccountId, defaultTagId: null, defaultPlanType: null }
    put.counterparties = [cp]
    put.counterpartyIdentifiers = [{ id: 'ci1', counterpartyId: 'cp-own', kind: 'statement_name', value: 'Test Sender', valueHash: null, valueEnc: null, last4: null, validFrom: '2020-01-01', validTo: null }]
  }
  await t.storage.applyBatch({ put } as never)
  const task = await createStatementTask(t.ctx, st, 'a.pdf')
  await saveComparison(t.ctx, task.id, await compareTask(t.ctx, task.id))
  return { ...t, st, task }
}


const kinds = async (ctx: Parameters<typeof listTaskProblems>[0], id: string) => (await listTaskProblems(ctx, id)).map((p) => p.kind).sort()
const first = async (ctx: Parameters<typeof listTaskProblems>[0], id: string, kind: string) => (await listTaskProblems(ctx, id)).find((p) => p.kind === kind)!
const withCp = (t: Transaction): Transaction => ({ ...t, counterpartyId: 'cp-own' })

describe('решение проблем выписки', () => {
  it('дата расходится (в допуске 3 дня): проблема есть, решения нет, «Готово» заблокировано, строка не задваивается', async () => {
    const { ctx, storage, task } = await prepared({ txs: [tx('a', '2026-09-05', -1000)] })       // выписка: -10,00 на 03.09
    expect(await kinds(ctx, task.id)).toContain('date_mismatch')
    const p = await first(ctx, task.id, 'date_mismatch')
    await expect(resolveProblem(ctx, task.id, p.id, { kind: 'keep' })).rejects.toThrow(/решения пока нет/)
    await expect(finishStatementTask(ctx, task.id)).rejects.toThrow(/нерешённые/)
    expect(await storage.listTransactions({ accountId: ID.space })).toHaveLength(1)
  })

  it('дата дальше допуска: две разные операции (новая и лишняя в базе)', async () => {
    const { ctx, task } = await prepared({ txs: [tx('a', '2026-09-10', -1000)] })
    expect(await kinds(ctx, task.id)).not.toContain('date_mismatch')
  })

  it('сумма расходится: принять сумму выписки правит операцию и снимает проблему', async () => {
    const { ctx, storage, task } = await prepared({ senderAccountId: null, txs: [withCp(tx('a', '2026-09-07', 49000))] })
    expect(await kinds(ctx, task.id)).toEqual(['amount_mismatch'])
    const p = await first(ctx, task.id, 'amount_mismatch')
    expect(p.details).toMatchObject({ amountMinor: 50000, dbAmountMinor: 49000 })
    await resolveProblem(ctx, task.id, p.id, { kind: 'accept_statement' })
    const t = (await storage.listTransactions({ accountId: ID.space })).find((x) => x.id === 'a')!
    expect([t.amountMinor, t.bookedAt]).toEqual([50000, '2026-09-06T10:00:03.000Z'])
    expect(await kinds(ctx, task.id)).toEqual([])
    expect((await finishStatementTask(ctx, task.id)).written).toBe(2)
  })

  it('сумма расходится: оставить базу (строка не пишется) и «разные операции»', async () => {
    const a = await prepared({ senderAccountId: null, txs: [withCp(tx('a', '2026-09-07', 49000))] })
    await resolveProblem(a.ctx, a.task.id, (await first(a.ctx, a.task.id, 'amount_mismatch')).id, { kind: 'keep_base' })
    expect(await kinds(a.ctx, a.task.id)).toEqual([])
    expect((await finishStatementTask(a.ctx, a.task.id)).written).toBe(2)
    expect((await a.storage.listTransactions({ accountId: ID.space })).find((x) => x.id === 'a')!.amountMinor).toBe(49000)

    const b = await prepared({ senderAccountId: null, txs: [withCp(tx('a', '2026-09-07', 49000))] })
    await resolveProblem(b.ctx, b.task.id, (await first(b.ctx, b.task.id, 'amount_mismatch')).id, { kind: 'distinct' })
    expect(await kinds(b.ctx, b.task.id)).toEqual(['db_only', 'transfer_unpaired'])
  })

  it('только в базе: оставить или удалить (мягко)', async () => {
    const a = await prepared({ txs: [tx('x', '2026-09-04', -777)] })
    expect(await kinds(a.ctx, a.task.id)).toEqual(['db_only'])
    await resolveProblem(a.ctx, a.task.id, (await first(a.ctx, a.task.id, 'db_only')).id, { kind: 'keep' })
    expect(await kinds(a.ctx, a.task.id)).toEqual([])
    expect((await finishStatementTask(a.ctx, a.task.id)).written).toBe(3)

    const b = await prepared({ txs: [tx('x', '2026-09-04', -777)] })
    await resolveProblem(b.ctx, b.task.id, (await first(b.ctx, b.task.id, 'db_only')).id, { kind: 'delete' })
    expect((await b.storage.listTransactions({ includeDeleted: true, accountId: ID.space })).find((t) => t.id === 'x')!.deletedAt).not.toBeNull()
    expect(await kinds(b.ctx, b.task.id)).toEqual([])
  })

  it('счёта нет: добавить признак (4 цифры) существующему счёту той же валюты', async () => {
    const { ctx, storage, task } = await prepared({ identifier: false })
    const p = await first(ctx, task.id, 'account_missing')
    await expect(resolveProblem(ctx, task.id, p.id, { kind: 'add_identifier', accountId: ID.cashUah })).rejects.toThrow(/валюта счёта/)
    await resolveProblem(ctx, task.id, p.id, { kind: 'add_identifier', accountId: ID.space })
    expect(await kinds(ctx, task.id)).toEqual([])
    expect((await storage.listAccountIdentifiers({ accountId: ID.space }))[0]).toMatchObject({ kind: 'account_number', last4: expect.stringMatching(/^[0-9a-z]{4}$/) })
    expect((await finishStatementTask(ctx, task.id)).written).toBe(3)
  })

  it('перевод без пары: записать как обычный приход', async () => {
    const { ctx, storage, task } = await prepared({ senderAccountId: null })
    expect(await kinds(ctx, task.id)).toEqual(['transfer_unpaired'])
    await resolveProblem(ctx, task.id, (await first(ctx, task.id, 'transfer_unpaired')).id, { kind: 'plain' })
    expect(await kinds(ctx, task.id)).toEqual([])
    expect((await finishStatementTask(ctx, task.id)).written).toBe(3)
    expect((await storage.listTransactions({ accountId: ID.space })).filter((t) => t.type === 'income' && t.transferId === null)).toHaveLength(1)
  })

  it('чужое действие и не владелец отклоняются', async () => {
    const { ctx, task } = await prepared({ txs: [tx('x', '2026-09-04', -777)] })
    await expect(resolveProblem(ctx, task.id, (await first(ctx, task.id, 'db_only')).id, { kind: 'plain' })).rejects.toThrow(/не подходит/)
    const o = await prepared({ txs: [tx('x', '2026-09-04', -777)] })
    const ctx2 = { ...o.ctx, actor: { userId: 'u2', isOwner: false } }
    await expect(resolveProblem(ctx2, o.task.id, (await first(o.ctx, o.task.id, 'db_only')).id, { kind: 'keep' })).rejects.toThrow(/владелец/)
  })
})
