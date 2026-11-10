// Контрактные тесты хранилища: один набор для любой реализации (memory, supabase, sqlite).
// Окружение даёт реализация: готовые счета, генератор id нужного формата, пользователь для журнала.
import { describe, expect, it } from 'vitest'
import type { Storage } from '../src/data/storage'
import type { NewAuditEntry, Transaction } from '../src/data/types'

export interface ContractEnv {
  storage: Storage
  a1: string                  // два существующих счёта в валюте 'eur'
  a2: string
  newId: () => string         // новый уникальный id (для Supabase это uuid)
  userId: string | null       // кого писать в журнал (для Supabase должен быть auth.uid())
  /** Поддерживает ли хранилище полную замену данных (importAll). Supabase нет. */
  supportsReplace: boolean
  /** Метка запуска: журнал в реальной базе общий, поэтому тесты ищут только свои записи. */
  token: string
}

const TS = (iso: string) => new Date(iso).toISOString()   // канонический вид: с миллисекундами и Z

const tx = (env: ContractEnv, id: string, accountId: string, bookedAt: string, over: Partial<Transaction> = {}): Transaction => ({
  id, accountId, counterpartyId: null, importId: null, source: 'manual', bookedAt: TS(bookedAt), type: 'income', amountMinor: 100,
  currencyKey: 'eur', originalAmountMinor: null, originalCurrencyKey: null, tagId: null, planType: null, comment: null,
  transferId: null, dedupeHash: null, deletedAt: null, isOpening: false, raw: null, createdBy: null,
  createdAt: TS('2026-11-01T00:00:00Z'), updatedAt: TS('2026-11-01T00:00:00Z'), ...over,
})

const audit = (env: ContractEnv, action: string, details: NewAuditEntry['details'] = null): NewAuditEntry => ({
  at: TS('2026-11-01T00:00:00Z'), userId: env.userId, action: `${env.token}:${action}`,
  tableName: null, recordId: null, oldData: null, newData: null, details,
})

export function runStorageContract(name: string, make: () => Promise<ContractEnv>) {
  describe(`контракт хранилища: ${name}`, () => {
    it('запись пакета и чтение, upsert по ключу', async () => {
      const e = await make(); const s = e.storage
      const id = e.newId()
      await s.applyBatch({ put: { transactions: [tx(e, id, e.a1, '2026-10-01T10:00:00Z')] } })
      await s.applyBatch({ put: { transactions: [tx(e, id, e.a1, '2026-10-01T10:00:00Z', { amountMinor: 250 })] } })
      expect((await s.getTransaction(id))!.amountMinor).toBe(250)
      expect(await s.getTransaction(e.newId())).toBeNull()
    })

    it('суммы: минусы, большие числа, оригинальная сумма в другой валюте', async () => {
      const e = await make(); const s = e.storage
      const [x, y, z] = [e.newId(), e.newId(), e.newId()]
      await s.applyBatch({ put: { transactions: [
        tx(e, x, e.a1, '2026-10-01T10:00:00Z', { type: 'expense', amountMinor: -1 }),
        tx(e, y, e.a1, '2026-10-01T11:00:00Z', { amountMinor: 123456789012 }),
        tx(e, z, e.a1, '2026-10-01T12:00:00Z', { type: 'expense', amountMinor: -1999, originalAmountMinor: -2100, originalCurrencyKey: 'eur' }),
      ] } })
      expect((await s.getTransaction(x))!.amountMinor).toBe(-1)
      expect((await s.getTransaction(y))!.amountMinor).toBe(123456789012)
      const t = (await s.getTransaction(z))!
      expect([t.amountMinor, t.originalAmountMinor, t.originalCurrencyKey]).toEqual([-1999, -2100, 'eur'])
    })

    it('выборки: счёт, диапазон включительно, удалённые, начальные, типы', async () => {
      const e = await make(); const s = e.storage
      const [t1, t2, t3, t4] = [e.newId(), e.newId(), e.newId(), e.newId()]
      await s.applyBatch({ put: { transactions: [
        tx(e, t1, e.a1, '2026-10-01T10:00:00Z'),
        tx(e, t2, e.a1, '2026-10-02T10:00:00Z', { deletedAt: TS('2026-10-03T00:00:00Z') }),
        tx(e, t3, e.a1, '2026-10-03T10:00:00Z', { type: 'adjustment', isOpening: true }),
        tx(e, t4, e.a2, '2026-10-01T10:00:00Z'),
      ] } })
      const ids = async (q = {}) => (await s.listTransactions(q)).map((t) => t.id)
      expect(await ids({ accountId: e.a1 })).toEqual([t1, t3])
      expect(await ids({ accountId: e.a1, includeDeleted: true })).toEqual([t1, t2, t3])
      expect(await ids({ accountId: e.a1, deletedOnly: true })).toEqual([t2])
      expect(await ids({ accountId: e.a1, bookedTo: TS('2026-10-01T10:00:00Z') })).toEqual([t1])
      expect(await ids({ accountId: e.a1, bookedFrom: TS('2026-10-03T10:00:00Z') })).toEqual([t3])
      expect(await ids({ accountId: e.a1, isOpening: true })).toEqual([t3])
      expect(await ids({ accountId: e.a1, types: ['adjustment'] })).toEqual([t3])
      expect(await ids({ accountIds: [e.a1, e.a2] })).toHaveLength(3)
      expect(await ids({ accountIds: [] })).toEqual([])
    })

    it('пакет атомарен: при ошибке не пишется ничего', async () => {
      const e = await make(); const s = e.storage
      const bad = { ...tx(e, '', e.a1, '2026-10-01T10:00:00Z') }
      await expect(s.applyBatch({
        put: { transactions: [tx(e, e.newId(), e.a1, '2026-10-01T10:00:00Z'), bad] },
        audit: [audit(e, 'atomic')],
      })).rejects.toThrow()
      expect(await s.listTransactions({ accountId: e.a1, includeDeleted: true })).toEqual([])
      expect((await s.listAudit()).filter((l) => l.action.startsWith(e.token))).toEqual([])
    })

    it('удаление пачкой и журнал с возрастающими id', async () => {
      const e = await make(); const s = e.storage
      const [t1, t2] = [e.newId(), e.newId()]
      await s.applyBatch({
        put: { transactions: [tx(e, t1, e.a1, '2026-10-01T10:00:00Z'), tx(e, t2, e.a1, '2026-10-02T10:00:00Z')] },
        audit: [audit(e, 'a', { n: 1 }), audit(e, 'b')],
      })
      await s.applyBatch({ deleteTransactionIds: [t1] })
      expect((await s.listTransactions({ accountId: e.a1, includeDeleted: true })).map((t) => t.id)).toEqual([t2])
      const log = (await s.listAudit()).filter((l) => l.action.startsWith(e.token))
      expect(log.map((l) => l.action.slice(e.token.length + 1))).toEqual(['b', 'a'])
      expect(log[0]!.id).toBeGreaterThan(log[1]!.id)
      expect(log[1]!.details).toEqual({ n: 1 })
      expect(log[1]!.userId).toBe(e.userId)
    })

    it('курс остаётся строкой с восемью знаками', async () => {
      const e = await make(); const s = e.storage
      const date = '2001-01-0' + (1 + Math.floor(Math.random() * 9))
      const id = e.newId()
      await s.applyBatch({ put: { fxRates: [{ id, rateDate: date, baseCurrencyKey: 'eur', quoteCurrencyKey: 'usd', rate: '1.08500000', source: e.token.slice(0, 24) }] } })
      const r = (await s.listFxRates({ toDate: date })).find((x) => x.id === id)!
      expect(r.rate).toBe('1.08500000')
      expect(await s.listFxRates({ toDate: '2000-12-31' })).not.toContainEqual(expect.objectContaining({ id }))
    })

    it('контрольные точки: сумма в валюте счёта, фильтры', async () => {
      const e = await make(); const s = e.storage
      const [c1, c2] = [e.newId(), e.newId()]
      const cp = (id: string, asOf: string, bal: number) => ({
        id, accountId: e.a1, asOf: TS(asOf), balanceMinor: bal, kind: 'balance' as const, source: 'manual' as const,
        status: 'active' as const, note: null, createdBy: null, createdAt: TS('2026-11-01T00:00:00Z'),
      })
      await s.applyBatch({ put: { checkpoints: [cp(c1, '2026-10-01T00:00:00Z', 124558), cp(c2, '2026-10-05T00:00:00Z', -5)] } })
      const all = (await s.listCheckpoints({ accountIds: [e.a1] })).filter((c) => [c1, c2].includes(c.id))
      expect(all.map((c) => [c.id, c.balanceMinor])).toEqual([[c1, 124558], [c2, -5]])
      const early = await s.listCheckpoints({ accountIds: [e.a1], asOfTo: TS('2026-10-02T00:00:00Z') })
      expect(early.map((c) => c.id)).toContain(c1)
      expect(early.map((c) => c.id)).not.toContain(c2)
    })

    it('данные возвращаются копиями', async () => {
      const e = await make(); const s = e.storage
      const id = e.newId()
      await s.applyBatch({ put: { transactions: [tx(e, id, e.a1, '2026-10-01T10:00:00Z')] } })
      const t = (await s.getTransaction(id))!
      t.amountMinor = 999
      expect((await s.getTransaction(id))!.amountMinor).toBe(100)
    })

    it('выгрузка содержит записанное, raw и порядок сохраняются', async () => {
      const e = await make(); const s = e.storage
      const id = e.newId()
      await s.applyBatch({ put: { transactions: [tx(e, id, e.a1, '2026-10-01T10:00:00Z', { raw: { k: [1, 2], s: 'x' } })] } })
      const dump = await s.exportAll()
      expect(dump.format).toBe('fin-control-dump')
      expect(dump.data.transactions.find((t) => t.id === id)!.raw).toEqual({ k: [1, 2], s: 'x' })
    })

    if (name === 'memory') {
      it('полная замена: выгрузка и загрузка возвращают те же данные', async () => {
        const a = await make(); const b = await make()
        const id = a.newId()
        await a.storage.applyBatch({ put: { transactions: [tx(a, id, a.a1, '2026-10-01T10:00:00Z', { raw: { k: [1, 2] } })] }, audit: [audit(a, 'x', { n: 1 })] })
        const dump = await a.storage.exportAll()
        await b.storage.applyBatch({ put: { transactions: [tx(b, 'лишняя', 'a9', '2026-01-01T00:00:00Z')] } })
        await b.storage.importAll(dump)
        const again = await b.storage.exportAll()
        expect(again.data).toEqual(dump.data)
        expect(again.auditLog).toEqual(dump.auditLog)
      })
    } else {
      it('полная замена не поддерживается и не портит данные', async () => {
        const e = await make()
        expect(e.supportsReplace).toBe(false)
        await expect(e.storage.importAll(await e.storage.exportAll())).rejects.toThrow(/STORAGE/)
      })
    }
  })
}
