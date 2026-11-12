// Интерфейс хранилища: простые чтение и запись. Никаких бизнес-правил внутри.
// Реализации: memory/ (тесты), supabase/ (шаг 4б), sqlite/ (позже).
import type {
  AuditEntry, BalanceCheckpoint, EntityMap, EntityName, FxRate, NewAuditEntry,
  PeriodLock, Transaction, TransactionType, AccountIdentifier,
} from './types'

/** Сущности, которые отдаются списком целиком (небольшие таблицы). */
export type SmallEntity =
  | 'appSettings' | 'planTypes' | 'countries' | 'currencies' | 'institutions' | 'projects'
  | 'accounts' | 'tagGroups' | 'tags' | 'counterparties' | 'counterpartyIdentifiers'
  | 'fxSourcePriorities'

export interface TransactionQuery {
  accountId?: string
  accountIds?: string[]
  bookedFrom?: string          // ISO, включительно
  bookedTo?: string            // ISO, включительно
  includeDeleted?: boolean     // по умолчанию false (deleted_at is null)
  deletedOnly?: boolean
  isOpening?: boolean
  types?: TransactionType[]
}
export interface CheckpointQuery { accountIds?: string[]; asOfTo?: string }
export interface IdentifierQuery { accountId?: string; valueHash?: string }
export interface FxRateQuery { toDate?: string }
export interface AuditQuery { limit?: number; beforeId?: number }

/** Пакет записей, применяется атомарно: всё или ничего. Поведение — upsert по первичному ключу. */
export interface WriteBatch {
  put?: { [K in EntityName]?: EntityMap[K][] }
  deleteTransactionIds?: string[]
  audit?: NewAuditEntry[]
  /** Выдать пользователю доступ владельца к новым счетам. Хранилище без пользователей (память, SQLite) это игнорирует. */
  grantOwnerAccess?: { accountId: string; userId: string }[]
}

export const DUMP_FORMAT = 'fin-control-dump'
export interface DataDump {
  format: typeof DUMP_FORMAT
  version: 1
  exportedAt: string
  data: { [K in EntityName]: EntityMap[K][] }
  auditLog: AuditEntry[]
}

export interface Storage {
  list<K extends SmallEntity>(entity: K): Promise<EntityMap[K][]>
  getTransaction(id: string): Promise<Transaction | null>
  listTransactions(q?: TransactionQuery): Promise<Transaction[]>
  listCheckpoints(q?: CheckpointQuery): Promise<BalanceCheckpoint[]>
  listAccountIdentifiers(q?: IdentifierQuery): Promise<AccountIdentifier[]>
  listPeriodLocks(): Promise<PeriodLock[]>
  listFxRates(q?: FxRateQuery): Promise<FxRate[]>
  listAudit(q?: AuditQuery): Promise<AuditEntry[]>
  applyBatch(batch: WriteBatch): Promise<void>
  exportAll(): Promise<DataDump>
  /** Полная замена данных содержимым выгрузки. */
  importAll(dump: DataDump): Promise<void>
}
