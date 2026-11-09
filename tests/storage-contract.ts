// Контрактные тесты хранилища: один набор для любой реализации (memory, supabase, sqlite).
import { describe, expect, it } from 'vitest'
import type { Storage } from '../src/data/storage'
import type { Transaction } from '../src/data/types'

const tx = (id: string, accountId: string, bookedAt: string, over: Partial<Transaction> = {}): Transaction => ({
  id, accountId, counterpartyId: null, importId: null, source: 'manual', bookedAt, type: 'income', amountMinor: 100,
  currencyKey: 'eur', originalAmountMinor: null, originalCurrencyKey: null, tagId: null, planType: null, comment: null,
  transferId: null, dedupeHash: null, deletedAt: null, isOpening: false, raw: null, createdBy: null,
  createdAt: '2026-11-01T00:00:00.000Z', updatedAt: '2026-11-01T00:00:00.000Z', ...over,
})

export function runStorageContract(name: string, make: () => Promise<Storage>) {
  describe(`контракт хранилища: ${name}`, () => {
    it('запись пакета и чтение, upsert по ключу', async () => {
      const s = await make()
      await s.applyBatch({ put: { transactions: [tx('t1', 'a1', '2026-10-01T10:00:00Z')] } })
      await s.applyBatch({ put: { transactions: [tx('t1', 'a1', '2026-10-01T10:00:00Z', { amountMinor: 250 })] } })
      expect((await s.getTransaction('t1'))!.amountMinor).toBe(250)
      expect(await s.getTransaction('нет')).toBeNull()
    })
    it('выборки: счёт, диапазон включительно, удалённые, начальные, типы', async () => {
      const s = await make()
      await s.applyBatch({ put: { transactions: [
        tx('t1', 'a1', '2026-10-01T10:00:00Z'),
        tx('t2', 'a1', '2026-10-02T10:00:00Z', { deletedAt: '2026-10-03T00:00:00.000Z' }),
        tx('t3', 'a1', '2026-10-03T10:00:00Z', { type: 'adjustment', isOpening: true }),
        tx('t4', 'a2', '2026-10-01T10:00:00Z'),
      ] } })
      const ids = async (q = {}) => (await s.listTransactions(q)).map((t) => t.id)
      expect(await ids({ accountId: 'a1' })).toEqual(['t1', 't3'])
      expect(await ids({ accountId: 'a1', includeDeleted: true })).toEqual(['t1', 't2', 't3'])
      expect(await ids({ accountId: 'a1', deletedOnly: true })).toEqual(['t2'])
      expect(await ids({ accountId: 'a1', bookedTo: '2026-10-01T10:00:00Z' })).toEqual(['t1'])
      expect(await ids({ accountId: 'a1', bookedFrom: '2026-10-03T10:00:00Z' })).toEqual(['t3'])
      expect(await ids({ accountId: 'a1', isOpening: true })).toEqual(['t3'])
      expect(await ids({ accountId: 'a1', types: ['adjustment'] })).toEqual(['t3'])
      expect(await ids({ accountIds: ['a1', 'a2'] })).toHaveLength(3)
    })
    it('пакет атомарен: при ошибке не пишется ничего', async () => {
      const s = await make()
      const bad = { ...tx('', 'a1', '2026-10-01T10:00:00Z') }
      await expect(s.applyBatch({
        put: { transactions: [tx('ok', 'a1', '2026-10-01T10:00:00Z'), bad] },
        audit: [{ at: '2026-11-01T00:00:00.000Z', userId: null, action: 'x', tableName: null, recordId: null, oldData: null, newData: null, details: null }],
      })).rejects.toThrow()
      expect(await s.listTransactions({ includeDeleted: true })).toEqual([])
      expect(await s.listAudit()).toEqual([])
    })
    it('удаление пачкой и журнал с возрастающими id', async () => {
      const s = await make()
      const a = { at: '2026-11-01T00:00:00.000Z', userId: null, action: 'a', tableName: null, recordId: null, oldData: null, newData: null, details: null }
      await s.applyBatch({ put: { transactions: [tx('t1', 'a1', '2026-10-01T10:00:00Z'), tx('t2', 'a1', '2026-10-02T10:00:00Z')] }, audit: [a, { ...a, action: 'b' }] })
      await s.applyBatch({ deleteTransactionIds: ['t1'] })
      expect((await s.listTransactions({ includeDeleted: true })).map((t) => t.id)).toEqual(['t2'])
      const log = await s.listAudit()
      expect(log.map((l) => l.action)).toEqual(['b', 'a'])
      expect(log[0]!.id).toBeGreaterThan(log[1]!.id)
    })
    it('выгрузка и загрузка возвращают те же данные (полная замена)', async () => {
      const a = await make()
      await a.applyBatch({
        put: {
          currencies: [{ key: 'eur', code: 'EUR', name: null, decimals: 2 }],
          transactions: [tx('t1', 'a1', '2026-10-01T10:00:00Z', { raw: { k: [1, 2] } })],
          fxRates: [{ id: 'r', rateDate: '2026-10-01', baseCurrencyKey: 'eur', quoteCurrencyKey: 'usd', rate: '1.08500000', source: 'manual' }],
        },
        audit: [{ at: '2026-11-01T00:00:00.000Z', userId: 'u', action: 'x', tableName: null, recordId: null, oldData: null, newData: null, details: { n: 1 } }],
      })
      const dump = await a.exportAll()
      const b = await make()
      await b.applyBatch({ put: { transactions: [tx('лишняя', 'a9', '2026-01-01T00:00:00Z')] } })
      await b.importAll(dump)
      const again = await b.exportAll()
      expect(again.data).toEqual(dump.data)
      expect(again.auditLog).toEqual(dump.auditLog)
      expect((await b.listFxRates())[0]!.rate).toBe('1.08500000')   // курс остаётся строкой
    })
    it('данные возвращаются копиями', async () => {
      const s = await make()
      await s.applyBatch({ put: { transactions: [tx('t1', 'a1', '2026-10-01T10:00:00Z')] } })
      const t = (await s.getTransaction('t1'))!
      t.amountMinor = 999
      expect((await s.getTransaction('t1'))!.amountMinor).toBe(100)
    })
  })
}
