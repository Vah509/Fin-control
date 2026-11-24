import { describe, expect, it } from 'vitest'
import { compareWithDb, parseSlspStatement } from '../../src/core/statements'
import { applyTaskOpeningFixes, checkTaskBalances, createStatementTask, planTaskOpeningFixes, saveComparison } from '../../src/core'
import type { Transaction } from '../../src/data/types'
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

async function prep(txs: Transaction[]) {
  const t = await setup({ withCrypto: true })
  const st = stmt()
  await t.storage.applyBatch({ put: { transactions: txs, accountIdentifiers: [{ id: 'i1', accountId: ID.space, kind: 'account_number', valueHash: 'h', valueEnc: 'e', last4: st.accounts[0]!.key, validFrom: '2020-01-01', validTo: null }] } } as never)
  const task = await createStatementTask(t.ctx, st, 'a.pdf')
  await saveComparison(t.ctx, task.id, await compareWithDb(t.ctx, st))
  return { ...t, task }
}
const open = (date: string, amount: number): Transaction => ({ ...tx('old-open', date, amount), type: 'adjustment', isOpening: true })
const all = async (t: Awaited<ReturnType<typeof prep>>) => t.storage.listTransactions({ accountId: ID.space })

describe('начальный остаток из выписки (шаг 5)', () => {
  it('пустой счёт: создаётся начальный остаток, остатки сходятся', async () => {
    const t = await prep([])
    const p = await planTaskOpeningFixes(t.ctx, t.task.id)
    expect(p.plans).toHaveLength(1)
    expect(p.plans[0]).toMatchObject({ kind: 'create', openingMinor: 100000 })
    expect((await checkTaskBalances(t.ctx, t.task.id)).items[0]!.startOk).toBe(false)
    await applyTaskOpeningFixes(t.ctx, t.task.id, [p.plans[0]!.accountKey])
    const b = await checkTaskBalances(t.ctx, t.task.id)
    expect(b.items[0]).toMatchObject({ startOk: true, endOk: true })
    expect((await all(t)).filter((x) => x.isOpening)).toHaveLength(1)
  })
  it('более ранняя выписка, позже стоит начальный остаток: разница становится корректировкой', async () => {
    const t = await prep([open('2026-10-15', 200000)])
    const p = await planTaskOpeningFixes(t.ctx, t.task.id)
    expect(p.plans[0]).toMatchObject({ kind: 'move', oldOpeningMinor: 200000, gapMinor: 200000 - 147000 })
    await applyTaskOpeningFixes(t.ctx, t.task.id, [p.plans[0]!.accountKey])
    const rows = await all(t)
    expect(rows.filter((x) => x.isOpening)).toHaveLength(1)
    const adj = rows.find((x) => x.id === 'old-open')!
    expect(adj).toMatchObject({ isOpening: false, amountMinor: 53000, type: 'adjustment' })
    expect(Date.parse(adj.bookedAt)).toBeGreaterThan(Date.parse('2026-09-30T23:59:59Z'))
  })
  it('старый остаток равен концу выписки: он удаляется, лишней корректировки нет', async () => {
    const t = await prep([open('2026-10-15', 147000)])
    const p = await planTaskOpeningFixes(t.ctx, t.task.id)
    expect(p.plans[0]).toMatchObject({ kind: 'move', gapMinor: 0 })
    await applyTaskOpeningFixes(t.ctx, t.task.id, [p.plans[0]!.accountKey])
    const rows = await all(t)
    expect(rows.filter((x) => !x.deletedAt && x.type === 'adjustment')).toHaveLength(1)
    expect((await checkTaskBalances(t.ctx, t.task.id)).items[0]!.startOk).toBe(true)
  })
  it('до начала периода уже есть записи: предложения нет', async () => {
    const t = await prep([open('2026-08-01', 50000), tx('x', '2026-08-20', -1000)])
    const p = await planTaskOpeningFixes(t.ctx, t.task.id)
    expect(p.plans).toHaveLength(0)
  })
  it('пересечение с начальным остатком внутри периода: блок', async () => {
    const t = await prep([open('2026-09-04', 99000)])
    const p = await planTaskOpeningFixes(t.ctx, t.task.id)
    expect(p.plans).toHaveLength(0)
    expect(p.blocked).toHaveLength(1)
  })
})
