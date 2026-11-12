// Хранилище поверх Supabase. Только чтение и запись, никаких правил.
// Запись пакетом идёт одним вызовом SQL-функции apply_batch (миграция итерации 3, security invoker).
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  ENTITY_NAMES, type AccountIdentifier, type AuditEntry, type BalanceCheckpoint, type EntityMap, type EntityName,
  type FxRate, type PeriodLock, type Transaction,
} from '../types'
import {
  DUMP_FORMAT,
  type AuditQuery, type CheckpointQuery, type DataDump, type FxRateQuery, type IdentifierQuery,
  type SmallEntity, type Storage, type TransactionQuery, type WriteBatch,
} from '../storage'
import { SPECS, WRITE_ORDER, auditFromRow, auditToRow, fromRow, toRow, type MoneyEnv } from './columns'

const PAGE = 1000
type Row = Record<string, unknown>

/** Ошибка слоя хранения: сообщение начинается с «STORAGE:», исходный текст базы сохраняется. */
export class StorageError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(`STORAGE: ${message}`)
    this.name = 'StorageError'
  }
}

function dbFail(what: string, error: { message: string; code?: string }): never {
  throw new StorageError(`${what}: ${error.message}${error.code ? ` (${error.code})` : ''}`, error)
}

export class SupabaseStorage implements Storage {
  private decimals = new Map<string, number>()
  private accountCur = new Map<string, string>()
  private envLoaded = false

  constructor(private readonly db: SupabaseClient) {}

  // ---------- справочники для перевода денег ----------
  private async loadEnv(force = false) {
    if (this.envLoaded && !force) return
    const [cur, acc] = await Promise.all([
      this.db.from('currencies').select('key, decimals'),
      this.db.from('accounts').select('id, currency_key'),
    ])
    if (cur.error) dbFail('чтение валют', cur.error)
    if (acc.error) dbFail('чтение счетов', acc.error)
    this.decimals = new Map((cur.data as Row[]).map((r) => [r['key'] as string, Number(r['decimals'])]))
    this.accountCur = new Map((acc.data as Row[]).map((r) => [r['id'] as string, r['currency_key'] as string]))
    this.envLoaded = true
  }

  private env(): MoneyEnv {
    return {
      decimals: (k) => this.decimals.get(k) ?? this.missing(`валюта ${k}`),
      accountCurrency: (id) => this.accountCur.get(id) ?? this.missing(`счёт ${id}`),
    }
  }
  private missing(what: string): never {
    throw new StorageError(`не найдено в справочнике: ${what}`)
  }

  // ---------- чтение ----------
  /** Страницами по 1000 строк (лимит PostgREST). Порядок обязан быть стабильным. */
  private async fetchAll(make: () => { range: (a: number, b: number) => PromiseLike<{ data: unknown[] | null; error: { message: string; code?: string } | null }> }, what: string): Promise<Row[]> {
    const out: Row[] = []
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await make().range(from, from + PAGE - 1)
      if (error) dbFail(what, error)
      const rows = (data ?? []) as Row[]
      out.push(...rows)
      if (rows.length < PAGE) return out
    }
  }

  private async readEntity<K extends EntityName>(entity: K): Promise<EntityMap[K][]> {
    const spec = SPECS[entity]
    await this.loadEnv()
    const rows = await this.fetchAll(() => this.db.from(spec.table).select('*').order(spec.pk, { ascending: true }), `чтение ${spec.table}`)
    const env = this.env()
    return rows.map((r) => fromRow(entity, r, env))
  }

  async list<K extends SmallEntity>(entity: K): Promise<EntityMap[K][]> {
    return this.readEntity(entity)
  }

  async getTransaction(id: string): Promise<Transaction | null> {
    await this.loadEnv()
    const { data, error } = await this.db.from('transactions').select('*').eq('id', id).maybeSingle()
    if (error) dbFail('чтение операции', error)
    return data ? fromRow('transactions', data as Row, this.env()) : null
  }

  async listTransactions(q: TransactionQuery = {}): Promise<Transaction[]> {
    await this.loadEnv()
    const ids = q.accountIds ?? (q.accountId ? [q.accountId] : null)
    if (ids && ids.length === 0) return []
    const rows = await this.fetchAll(() => {
      let b = this.db.from('transactions').select('*')
      if (ids) b = b.in('account_id', ids)
      if (q.bookedFrom) b = b.gte('booked_at', q.bookedFrom)
      if (q.bookedTo) b = b.lte('booked_at', q.bookedTo)
      if (q.deletedOnly) b = b.not('deleted_at', 'is', null)
      else if (!q.includeDeleted) b = b.is('deleted_at', null)
      if (q.isOpening !== undefined) b = b.eq('is_opening', q.isOpening)
      if (q.types?.length) b = b.in('type', q.types)
      return b.order('booked_at', { ascending: true }).order('id', { ascending: true })
    }, 'чтение операций')
    const env = this.env()
    return rows.map((r) => fromRow('transactions', r, env))
  }

  async listCheckpoints(q: CheckpointQuery = {}): Promise<BalanceCheckpoint[]> {
    await this.loadEnv()
    if (q.accountIds && q.accountIds.length === 0) return []
    const rows = await this.fetchAll(() => {
      let b = this.db.from('balance_checkpoints').select('*')
      if (q.accountIds) b = b.in('account_id', q.accountIds)
      if (q.asOfTo) b = b.lte('as_of', q.asOfTo)
      return b.order('as_of', { ascending: true }).order('id', { ascending: true })
    }, 'чтение контрольных точек')
    const env = this.env()
    return rows.map((r) => fromRow('checkpoints', r, env))
  }

  async listAccountIdentifiers(q: IdentifierQuery = {}): Promise<AccountIdentifier[]> {
    await this.loadEnv()
    const rows = await this.fetchAll(() => {
      let b = this.db.from('account_identifiers').select('*')
      if (q.accountId) b = b.eq('account_id', q.accountId)
      if (q.valueHash) b = b.eq('value_hash', '\\x' + q.valueHash)
      return b.order('id', { ascending: true })
    }, 'чтение признаков счетов')
    const env = this.env()
    return rows.map((r) => fromRow('accountIdentifiers', r, env))
  }

  async listPeriodLocks(): Promise<PeriodLock[]> {
    await this.loadEnv()
    const rows = await this.fetchAll(
      () => this.db.from('period_locks').select('*').order('seq', { ascending: true }).order('id', { ascending: true }),
      'чтение закрытий периодов')
    const env = this.env()
    return rows.map((r) => fromRow('periodLocks', r, env))
  }

  async listFxRates(q: FxRateQuery = {}): Promise<FxRate[]> {
    await this.loadEnv()
    const rows = await this.fetchAll(() => {
      let b = this.db.from('fx_rates').select('*')
      if (q.toDate) b = b.lte('rate_date', q.toDate)
      return b.order('rate_date', { ascending: true }).order('id', { ascending: true })
    }, 'чтение курсов')
    const env = this.env()
    return rows.map((r) => fromRow('fxRates', r, env))
  }

  async listAudit(q: AuditQuery = {}): Promise<AuditEntry[]> {
    if (q.limit !== undefined) {
      let b = this.db.from('audit_log').select('*')
      if (q.beforeId !== undefined) b = b.lt('id', q.beforeId)
      const { data, error } = await b.order('id', { ascending: false }).limit(q.limit)
      if (error) dbFail('чтение журнала', error)
      return (data as Row[]).map(auditFromRow)
    }
    const rows = await this.fetchAll(() => {
      let b = this.db.from('audit_log').select('*')
      if (q.beforeId !== undefined) b = b.lt('id', q.beforeId)
      return b.order('id', { ascending: false })
    }, 'чтение журнала')
    return rows.map(auditFromRow)
  }

  // ---------- запись ----------
  /** Всё или ничего: один вызов SQL-функции = одна транзакция Postgres. */
  async applyBatch(batch: WriteBatch): Promise<void> {
    const put = batch.put ?? {}
    const hasPut = ENTITY_NAMES.some((n) => (put[n]?.length ?? 0) > 0)
    const hasDel = (batch.deleteTransactionIds?.length ?? 0) > 0
    const hasAudit = (batch.audit?.length ?? 0) > 0
    const grants = batch.grantOwnerAccess ?? []
    if (!hasPut && !hasDel && !hasAudit && grants.length === 0) return

    await this.loadEnv()
    // Новые валюты и счета из самого пакета нужны для перевода сумм в этом же пакете.
    const decimals = new Map(this.decimals)
    const accountCur = new Map(this.accountCur)
    for (const c of put.currencies ?? []) decimals.set(c.key, c.decimals)
    for (const a of put.accounts ?? []) accountCur.set(a.id, a.currencyKey)
    const env: MoneyEnv = {
      decimals: (k) => decimals.get(k) ?? this.missing(`валюта ${k}`),
      accountCurrency: (id) => accountCur.get(id) ?? this.missing(`счёт ${id}`),
    }

    const payload: { put: Record<string, Row[]>; delete_transaction_ids: string[]; audit: Row[] } = {
      put: {}, delete_transaction_ids: batch.deleteTransactionIds ?? [], audit: (batch.audit ?? []).map(auditToRow),
    }
    for (const name of WRITE_ORDER) {
      const rows = put[name] as EntityMap[typeof name][] | undefined
      if (rows?.length) payload.put[SPECS[name].table] = rows.map((r) => toRow(name, r as never, env))
    }
    if (grants.length) {
      payload.put['account_access'] = grants.map((g) => ({ account_id: g.accountId, user_id: g.userId, role: 'owner' }))
    }
    const { error } = await this.db.rpc('apply_batch', { p: payload })
    if (error) dbFail('запись пакета', error)

    // Пакет принят: обновляем кэш справочников.
    this.decimals = decimals
    this.accountCur = accountCur
  }

  // ---------- выгрузка и загрузка ----------
  async exportAll(): Promise<DataDump> {
    const data = {} as DataDump['data']
    for (const n of ENTITY_NAMES) (data as Record<string, unknown>)[n] = await this.readEntity(n)
    return {
      format: DUMP_FORMAT, version: 1, exportedAt: new Date().toISOString(), data,
      auditLog: (await this.listAudit()).sort((a, b) => a.id - b.id),
    }
  }

  /** Полная замена данных в Supabase не поддерживается: клиенту нельзя удалять справочники и историю.
   *  Загрузка файла выгрузки в Supabase делается слиянием (upsert по ключу) через ядро. */
  async importAll(_dump: DataDump): Promise<void> {
    throw new StorageError('полная замена данных в Supabase не поддерживается; используйте загрузку со слиянием')
  }

  /** Сбросить кэш справочников (например после входа под другим пользователем). */
  resetCache() {
    this.envLoaded = false
  }
}
