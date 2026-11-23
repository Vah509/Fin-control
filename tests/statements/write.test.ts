import { describe, expect, it } from 'vitest'
import { compareWithDb, parseSlspStatement } from '../../src/core/statements'
import { createStatementTask, finishStatementTask, listTaskProblems, saveComparison } from '../../src/core'
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
const rows = async (st: { listTransactions: (q: { accountId: string }) => Promise<Transaction[]> }) => (await st.listTransactions({ accountId: ID.space })).filter((t) => !t.isOpening)
const tx = (id: string, date: string, amountMinor: number): Transaction => ({
  id, accountId: ID.space, counterpartyId: null, importId: null, source: 'manual', bookedAt: `${date}T10:00:00.000Z`, type: amountMinor > 0 ? 'income' : 'expense',
  amountMinor, currencyKey: 'eur', originalAmountMinor: null, originalCurrencyKey: null, tagId: null, planType: null, comment: null,
  transferId: null, dedupeHash: null, deletedAt: null, isOpening: false, raw: null, createdBy: null, createdAt: '2026-11-01T00:00:00.000Z', updatedAt: '2026-11-01T00:00:00.000Z',
})
async function prepared(opts: { identifier?: boolean; txs?: Transaction[]; senderAccountId?: string | null; tamper?: boolean } = {}) {
  const t = await setup({ withCrypto: true })
  const st = stmt(opts.tamper)
  const opening: Transaction = { ...tx('opening', '2026-08-31', 100000), type: 'adjustment', isOpening: true }
  const put: Record<string, unknown[]> = { transactions: [opening, ...(opts.txs ?? [])] }
  if (opts.identifier !== false) put.accountIdentifiers = [{ id: 'i1', accountId: ID.space, kind: 'account_number', valueHash: 'h', valueEnc: 'e', last4: st.accounts[0]!.key, validFrom: '2020-01-01', validTo: null }]
  if (opts.senderAccountId !== undefined) {
    const cp: Counterparty = { id: 'cp-own', key: 'own', name: 'Свой: Test Sender', kind: 'own_account', accountId: opts.senderAccountId, defaultTagId: null, defaultPlanType: null }
    put.counterparties = [cp]
    put.counterpartyIdentifiers = [{ id: 'ci1', counterpartyId: 'cp-own', kind: 'statement_name', value: 'Test Sender', valueHash: null, valueEnc: null, last4: null, validFrom: '2020-01-01', validTo: null }]
  }
  await t.storage.applyBatch({ put } as never)
  const task = await createStatementTask(t.ctx, st, 'a.pdf')
  await saveComparison(t.ctx, task.id, await compareWithDb(t.ctx, st))
  return { ...t, st, task }
}

describe('запись операций выписки по «Готово»', () => {
  it('чистая выписка: 3 операции пишутся, повтор ничего не задваивает', async () => {
    const { ctx, storage, st, task } = await prepared()
    const r = await finishStatementTask(ctx, task.id)
    expect(r.written).toBe(3)
    const txs = (await rows(storage)).sort((a, b) => a.bookedAt.localeCompare(b.bookedAt))
    expect(txs.map((t) => [t.type, t.amountMinor, t.source])).toEqual([['expense', -1000, 'import'], ['expense', -2000, 'import'], ['income', 50000, 'import']])
    expect(txs[0]!.bookedAt).toBe('2026-09-03T10:00:01.000Z')           // 12:00 по Братиславе (UTC+2) + №1 секунда
    const again = await compareWithDb(ctx, st)
    expect(again.problems).toEqual([])
    expect(Object.values(again.inDb).every(Boolean)).toBe(true)
    await expect(finishStatementTask(ctx, task.id)).rejects.toThrow(/уже закрыта/)
    expect(await rows(storage)).toHaveLength(3)
  })

  it('часть уже в базе: пишется только остальное', async () => {
    const { ctx, storage, task } = await prepared({ txs: [tx('a', '2026-09-05', -2000), tx('b', '2026-09-06', 50000)] })
    expect((await finishStatementTask(ctx, task.id)).written).toBe(1)
    expect(await rows(storage)).toHaveLength(3)
  })

  it('лишняя операция в базе: проблема, ничего не пишется', async () => {
    const { ctx, storage, task } = await prepared({ txs: [tx('x', '2026-09-10', -777)] })
    await expect(finishStatementTask(ctx, task.id)).rejects.toThrow(/нерешённые/)
    expect((await listTaskProblems(ctx, task.id)).map((p) => p.kind)).toEqual(['db_only'])
    expect(await rows(storage)).toHaveLength(1)
  })

  it('счёта нет в базе: проблема account_missing, ничего не пишется', async () => {
    const { ctx, storage, task } = await prepared({ identifier: false })
    await expect(finishStatementTask(ctx, task.id)).rejects.toThrow(/нерешённые/)
    expect((await listTaskProblems(ctx, task.id)).map((p) => p.kind)).toEqual(['account_missing'])
    expect((await storage.listTransactions({})).filter((t) => !t.isOpening)).toHaveLength(0)
  })

  it('сверка не сошлась: запись невозможна', async () => {
    const { ctx, storage, task } = await prepared({ tamper: true })
    await expect(finishStatementTask(ctx, task.id)).rejects.toThrow(/сверка выписки не сошлась/)
    expect((await storage.listTransactions({})).filter((t) => !t.isOpening)).toHaveLength(0)
  })

  it('перевод на свой счёт в той же валюте: две записи с общим transfer_id', async () => {
    const { ctx, storage, task } = await prepared({ senderAccountId: ID.parents })
    expect((await finishStatementTask(ctx, task.id)).written).toBe(4)
    const space = (await rows(storage)).find((t) => t.type === 'transfer')!
    const pair = (await storage.listTransactions({ accountId: ID.parents })).find((t) => t.type === 'transfer')!
    expect([space.amountMinor, pair.amountMinor]).toEqual([50000, -50000])
    expect(space.transferId).toBeTruthy()
    expect(pair.transferId).toBe(space.transferId)
    expect(space.counterpartyId).toBe('cp-own')
  })

  it('перевод в другой валюте или без привязки счёта: проблема transfer_unpaired, ничего не пишется', async () => {
    for (const target of [ID.cashUah, null]) {
      const { ctx, storage, task } = await prepared({ senderAccountId: target })
      await expect(finishStatementTask(ctx, task.id)).rejects.toThrow(/нерешённые/)
      const p = await listTaskProblems(ctx, task.id)
      expect(p.map((x) => x.kind)).toEqual(['transfer_unpaired'])
      expect((await storage.listTransactions({})).filter((t) => !t.isOpening)).toHaveLength(0)
    }
  })
})
