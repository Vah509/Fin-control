import { describe, expect, it } from 'vitest'
import { balanceAt, buildStatementAccountIntoLedger, removeStatementAccountFromLedger } from '../../src/core'
import { ID, setup } from '../helpers'
import type { Account, StatementDocAccount, StatementDocRow } from '../../src/data/types'

type T = Awaited<ReturnType<typeof setup>>
let seq = 0
const uid = () => `x${++seq}`

/** Выдуманный документ выписки по счёту: rows = [день, сумма в копейках, контрагент или null]. */
async function doc(t: T, accountId: string, start: string, end: string, opening: number, closing: number, rows: [string, number, string | null][]): Promise<string> {
  const d = uid(), sa = uid()
  await t.storage.applyBatch({
    put: {
      statementDocuments: [{ id: d, kind: 'statement', institutionId: null, bank: 'slsp', fileName: 'f', contentHash: d, periodStart: start, periodEnd: end, parser: 'x', createdBy: null, createdAt: '2026-11-27T10:00:00.000Z' }],
      statementAccounts: [{ id: sa, documentId: d, accountId, periodStart: start, periodEnd: end, openingMinor: opening, closingMinor: closing, incomeMinor: null, expenseMinor: null, rowCount: rows.length, builtInAt: null } as StatementDocAccount],
      statementRows: rows.map(([day, amount, cp], i) => ({
        id: uid(), documentId: d, statementAccountId: sa, accountId, n: i + 1, bookedAt: `${day}T11:00:00.000Z`, valueDate: day, amountMinor: amount, feeMinor: 0, balanceAfterMinor: null,
        counterpartyId: cp, title: null, description: `r${i}`, cardMask: null, rowKey: `k-${d}-${i}`, duplicateOf: null,
      } as StatementDocRow)),
    },
  })
  return sa
}
const acc = async (t: T, id: string) => (await t.storage.list('accounts')).find((a) => a.id === id) as Account
const at = (day: string) => Date.parse(`${day}T22:59:59.000Z`)

describe('встраивание выписок в учёт (этап 2)', () => {
  it('встраивание, остатки по точкам при любом порядке загрузки, убрать из учёта', async () => {
    const t = await setup()
    // сначала поздняя выписка (август), потом ранняя (июль): остатки должны сойтись в обоих случаях
    const aug = await doc(t, ID.space, '2026-08-01', '2026-08-31', 100_00, 80_00, [['2026-08-05', -20_00, null]])
    const jul = await doc(t, ID.space, '2026-07-01', '2026-07-31', 50_00, 100_00, [['2026-07-10', 60_00, null], ['2026-07-20', -10_00, null]])
    const r1 = await buildStatementAccountIntoLedger(t.ctx, aug)
    expect(r1).toMatchObject({ created: 1, rows: 1 })
    const a = await acc(t, ID.space)
    expect(await balanceAt(t.ctx, a, at('2026-08-31'))).toBe(80_00)
    expect(await balanceAt(t.ctx, a, at('2026-08-10'))).toBe(80_00)
    await buildStatementAccountIntoLedger(t.ctx, jul)
    expect(await balanceAt(t.ctx, a, at('2026-07-31'))).toBe(100_00)
    expect(await balanceAt(t.ctx, a, at('2026-07-15'))).toBe(110_00)
    expect(await balanceAt(t.ctx, a, at('2026-08-31'))).toBe(80_00)
    expect((await t.storage.list('balancePeriods')).filter((p) => p.status === 'active')).toHaveLength(2)
    await expect(buildStatementAccountIntoLedger(t.ctx, jul)).rejects.toMatchObject({ code: 'INVALID_FIELD' })

    const rm = await removeStatementAccountFromLedger(t.ctx, jul)
    expect(rm.removed).toBe(2)
    expect((await t.storage.list('balancePeriods')).filter((p) => p.status === 'active')).toHaveLength(1)
    expect((await t.storage.list('statementAccounts')).find((x) => x.id === jul)!.builtInAt).toBeNull()
  })

  it('перевод между своими счетами: парная запись сразу, вторая сторона присваивается строке', async () => {
    const t = await setup()
    await t.storage.applyBatch({ put: { counterparties: [
      { id: 'cp-to-parents', key: 'to-parents', name: 'Родители', kind: 'own_account', accountId: ID.parents, defaultTagId: null, defaultPlanType: null },
      { id: 'cp-from-space', key: 'from-space', name: 'SPACE', kind: 'own_account', accountId: ID.space, defaultTagId: null, defaultPlanType: null },
    ] } as never })
    const space = await doc(t, ID.space, '2026-07-01', '2026-07-31', 500_00, 400_00, [['2026-07-04', -100_00, 'cp-to-parents']])
    const parents = await doc(t, ID.parents, '2026-07-01', '2026-07-31', 0, 100_00, [['2026-07-05', 100_00, 'cp-from-space']])
    const r1 = await buildStatementAccountIntoLedger(t.ctx, space)
    expect(r1.created).toBe(2)
    const r2 = await buildStatementAccountIntoLedger(t.ctx, parents)
    expect(r2).toMatchObject({ created: 0, adopted: 1 })
    const txs = (await t.storage.listTransactions({})).filter((x) => x.type === 'transfer')
    expect(txs).toHaveLength(2)
    expect(txs.every((x) => !!x.statementRowId || x.accountId === ID.parents)).toBe(true)
    // убрать вторую выписку: присвоенная операция удаляется, пара первой остаётся?  удаляются её собственные и авто-пары без ссылки
    const rm = await removeStatementAccountFromLedger(t.ctx, parents)
    expect(rm.removed).toBeGreaterThanOrEqual(1)
  })

  it('до первой точки остаток неизвестен в срезе', async () => {
    const t = await setup()
    const sa = await doc(t, ID.space, '2026-08-01', '2026-08-31', 100_00, 100_00, [])
    await buildStatementAccountIntoLedger(t.ctx, sa)
    const { getSnapshot } = await import('../../src/core')
    const snap = await getSnapshot(t.ctx, { date: '2026-07-15', baseCurrency: 'eur' } as never)
    const row = snap.rows.find((r: { accountId: string }) => r.accountId === ID.space)
    expect(row?.noBalance).toBe(true)
  })
})
