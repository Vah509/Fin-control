import {
  ENTITY_NAMES, PRIMARY_KEY,
  type AuditEntry, type EntityMap, type EntityName,
} from '../types'
import {
  DUMP_FORMAT,
  type AuditQuery, type CheckpointQuery, type DataDump, type FxRateQuery,
  type IdentifierQuery, type SmallEntity, type Storage, type TransactionQuery, type WriteBatch,
} from '../storage'

type Tables = { [K in EntityName]: Map<string, EntityMap[K]> }

function emptyTables(): Tables {
  const t = {} as Record<string, Map<string, unknown>>
  for (const n of ENTITY_NAMES) t[n] = new Map()
  return t as unknown as Tables
}
const clone = <T>(v: T): T => structuredClone(v)

export class MemoryStorage implements Storage {
  private tables = emptyTables()
  private audit: AuditEntry[] = []
  private auditSeq = 0

  private rows<K extends EntityName>(e: K): EntityMap[K][] {
    return [...this.tables[e].values()].map(clone)
  }

  async list<K extends SmallEntity>(entity: K): Promise<EntityMap[K][]> {
    return this.rows(entity)
  }

  async getTransaction(id: string) {
    const t = this.tables.transactions.get(id)
    return t ? clone(t) : null
  }

  async listTransactions(q: TransactionQuery = {}) {
    const ids = q.accountIds ?? (q.accountId ? [q.accountId] : null)
    const from = q.bookedFrom ? Date.parse(q.bookedFrom) : -Infinity
    const to = q.bookedTo ? Date.parse(q.bookedTo) : Infinity
    return this.rows('transactions')
      .filter((t) => {
        if (ids && !ids.includes(t.accountId)) return false
        const ms = Date.parse(t.bookedAt)
        if (ms < from || ms > to) return false
        if (q.deletedOnly) { if (t.deletedAt === null) return false }
        else if (!q.includeDeleted && t.deletedAt !== null) return false
        if (q.isOpening !== undefined && t.isOpening !== q.isOpening) return false
        if (q.types && !q.types.includes(t.type)) return false
        return true
      })
      .sort((a, b) => Date.parse(a.bookedAt) - Date.parse(b.bookedAt) || a.id.localeCompare(b.id))
  }

  async listCheckpoints(q: CheckpointQuery = {}) {
    const to = q.asOfTo ? Date.parse(q.asOfTo) : Infinity
    return this.rows('checkpoints')
      .filter((c) => (!q.accountIds || q.accountIds.includes(c.accountId)) && Date.parse(c.asOf) <= to)
      .sort((a, b) => Date.parse(a.asOf) - Date.parse(b.asOf))
  }

  async listAccountIdentifiers(q: IdentifierQuery = {}) {
    return this.rows('accountIdentifiers').filter(
      (i) => (!q.accountId || i.accountId === q.accountId) && (!q.valueHash || i.valueHash === q.valueHash),
    )
  }

  async listPeriodLocks() {
    return this.rows('periodLocks')
      .sort((a, b) => a.seq - b.seq)
  }

  async listFxRates(q: FxRateQuery = {}) {
    return this.rows('fxRates').filter((r) => !q.toDate || r.rateDate <= q.toDate)
  }

  async listAudit(q: AuditQuery = {}) {
    let rows = clone(this.audit).sort((a, b) => b.id - a.id)
    if (q.beforeId !== undefined) rows = rows.filter((r) => r.id < q.beforeId!)
    return q.limit ? rows.slice(0, q.limit) : rows
  }

  /** Атомарно: работаем с копией и подменяем её только при успехе. */
  async applyBatch(batch: WriteBatch) {
    const next = emptyTables()
    for (const n of ENTITY_NAMES) for (const [k, v] of this.tables[n]) (next[n] as Map<string, unknown>).set(k, v)
    const nextAudit = [...this.audit]
    let seq = this.auditSeq

    for (const name of ENTITY_NAMES) {
      const rows = batch.put?.[name]
      if (!rows) continue
      const pk = PRIMARY_KEY[name] as string
      for (const row of rows) {
        const key = (row as unknown as Record<string, unknown>)[pk]
        if (typeof key !== 'string' || key === '') throw new Error(`STORAGE: нет ключа ${pk} в ${name}`)
        ;(next[name] as Map<string, unknown>).set(key, clone(row))
      }
    }
    for (const id of batch.deleteTransactionIds ?? []) next.transactions.delete(id)
    for (const a of batch.audit ?? []) nextAudit.push({ ...clone(a), id: ++seq })

    this.tables = next
    this.audit = nextAudit
    this.auditSeq = seq
  }

  async exportAll(): Promise<DataDump> {
    const data = {} as DataDump['data']
    for (const n of ENTITY_NAMES) (data as Record<string, unknown>)[n] = this.rows(n)
    return { format: DUMP_FORMAT, version: 1, exportedAt: new Date().toISOString(), data, auditLog: clone(this.audit) }
  }

  async importAll(dump: DataDump) {
    if (dump.format !== DUMP_FORMAT || dump.version !== 1) throw new Error('STORAGE: неизвестный формат выгрузки')
    const tables = emptyTables()
    for (const n of ENTITY_NAMES) {
      const pk = PRIMARY_KEY[n] as string
      for (const row of dump.data[n] ?? []) {
        ;(tables[n] as Map<string, unknown>).set((row as unknown as Record<string, unknown>)[pk] as string, clone(row))
      }
    }
    this.tables = tables
    this.audit = clone(dump.auditLog ?? [])
    this.auditSeq = this.audit.reduce((m, a) => Math.max(m, a.id), 0)
  }
}
