// Типы данных. Одинаковы для любого хранилища. camelCase; соответствие колонкам БД
// (snake_case) делает слой хранения. Суммы: целые минорные единицы (number, safe integer).
// Курсы: строки десятичных чисел (не float). Даты: 'YYYY-MM-DD'. Время: ISO 8601 в UTC.

export type Json = null | boolean | number | string | Json[] | { [k: string]: Json }

export interface AppSetting { key: string; value: Json }
export interface PlanType { key: string; name: string; sortOrder: number }
export interface Country { key: string; name: string; timezone: string } // timezone: IANA или 'default'
export interface Currency { key: string; code: string; name: string | null; decimals: number }

export type InstitutionKind = 'bank' | 'wallet_service' | 'broker' | 'firm' | 'other'
export interface Institution {
  id: string; key: string; name: string; kind: InstitutionKind
  countryKey: string | null; appearance: Json
}

export interface Project { id: string; key: string; name: string; sortOrder: number; appearance: Json }

export type AccountType = 'bank' | 'wallet' | 'broker' | 'cash' | 'person' | 'firm'
export type TrackingMode = 'balance_only' | 'balance_and_movements'
export interface Account {
  id: string; key: string; name: string; type: AccountType
  institutionId: string | null; projectId: string; holder: string | null
  currencyKey: string; countryKey: string
  timezone: string | null            // пусто = пояс страны
  trackingMode: TrackingMode
  servicePercent: string | null      // десятичная строка, от -100 до 100
  appearance: Json; sortOrder: number
  archivedAt: string | null
}

export type IdentifierKind = 'account_number' | 'card_mask' | 'wallet_number' | 'statement_name'
export interface AccountIdentifier {
  id: string; accountId: string; kind: IdentifierKind
  valueHash: string   // hex HMAC-SHA256
  valueEnc: string    // base64 (iv + шифртекст AES-GCM)
  last4: string | null
  validFrom: string; validTo: string | null
}

export interface TagGroup { id: string; key: string; name: string; isService: boolean; sortOrder: number }
export interface Tag { id: string; key: string; groupId: string; name: string; sortOrder: number; archivedAt: string | null }

export type CounterpartyKind = 'shop' | 'person' | 'organization' | 'own_account'
export interface Counterparty {
  id: string; key: string; name: string; kind: CounterpartyKind
  accountId: string | null; defaultTagId: string | null; defaultPlanType: string | null
}
export type CounterpartyIdentifierKind = 'account_number' | 'statement_name' | 'name_pattern'
export interface CounterpartyIdentifier {
  id: string; counterpartyId: string; kind: CounterpartyIdentifierKind
  value: string | null; valueHash: string | null; valueEnc: string | null; last4: string | null
  validFrom: string; validTo: string | null
}

export type TransactionType = 'income' | 'expense' | 'transfer' | 'fee' | 'adjustment'
export type TransactionSource = 'import' | 'manual'
export interface Transaction {
  id: string; accountId: string; counterpartyId: string | null; importId: string | null
  source: TransactionSource; bookedAt: string; type: TransactionType
  amountMinor: number; currencyKey: string
  originalAmountMinor: number | null; originalCurrencyKey: string | null
  tagId: string | null; planType: string | null; comment: string | null
  transferId: string | null; dedupeHash: string | null; deletedAt: string | null
  isOpening: boolean; raw: Json | null
  createdBy: string | null; createdAt: string; updatedAt: string
}

/** balance: точка формы ввода остатка (сверяется с расчётом по движениям); portfolio_value: оценка портфеля; entered: остаток, введённый на экране «Ввод остатков» (учёт остатками, с движениями не сверяется). */
export type CheckpointKind = 'balance' | 'portfolio_value' | 'entered'
export interface BalanceCheckpoint {
  id: string; accountId: string; asOf: string; balanceMinor: number
  kind: CheckpointKind; source: 'manual' | 'statement'; status: 'active' | 'invalid'
  note: string | null; createdBy: string | null; createdAt: string
}

export interface PeriodLock {
  id: string; seq: number; projectId: string | null; lockedThrough: string
  lockedAt: string; lockedBy: string | null; status: 'active' | 'released'
  releasedAt: string | null; releasedBy: string | null; releaseReason: string | null
}

export interface FxRate {
  id: string; rateDate: string; baseCurrencyKey: string; quoteCurrencyKey: string
  rate: string        // 1 base = rate quote; десятичная строка
  source: string
}
export interface FxSourcePriority { source: string; priority: number } // меньше = важнее

export interface AuditEntry {
  id: number; at: string; userId: string | null; action: string
  tableName: string | null; recordId: string | null
  oldData: Json | null; newData: Json | null; details: Json | null
}
export type NewAuditEntry = Omit<AuditEntry, 'id'>

export type ImportJobStatus = 'preparing' | 'waiting_file' | 'review' | 'loaded' | 'cancelled'
/** Счёт в задании на импорт: остаток, введённый владельцем по данным банка на момент asOf. */
export interface ImportJobAccount { accountId: string; balanceMinor: number; asOf: string }
/** Ответ ИИ-чата, принятый в задание (один JSON; после загрузки в базу doc очищается, остаётся хэш). */
export interface ImportStoredResponse { id: string; receivedAt: string; doc: Json | null }
/** Решения владельца при разборе. Ключи: statement = маска карты (или ключ счёта), группа контрагентов = нормализованное название. */
export type ImportAccountDecision = { accountId: string } | 'skip'
export type ImportCpDecision = { mode: 'new' } | { mode: 'existing'; counterpartyId: string } | { mode: 'queue' }
export interface ImportDecisions {
  primary: string | null
  accounts: Record<string, ImportAccountDecision>
  openingFix: Record<string, 'adjust' | 'keep'>
  entryFix: Record<string, 'adjust' | 'keep'>
  counterparties: Record<string, ImportCpDecision>
  /** Подтверждённые «свои счета»: маска другой карты -> принято (true) или отклонено (false). */
  ownAccounts: Record<string, boolean>
  identifiers: Record<string, 'add' | 'reject'>
}
export interface ImportResult {
  loadedAt: string; transactions: number; adjustments: number; checkpointIds: string[]
  newCounterparties: number; skippedDuplicates: number; notes: string[]
  rolledBackAt: string | null
}
export interface ImportReviewState { responses: ImportStoredResponse[]; decisions: ImportDecisions; result: ImportResult | null }
export type StatementTaskStatus = 'active' | 'done' | 'deleted'
/** Задача разбора выписки. payload: разобранная выписка без полных номеров (см. core/statementTasks.ts). */
export interface StatementTask {
  id: string; title: string; fileName: string; status: StatementTaskStatus
  state: Json; payload: Json
  createdBy: string | null; createdAt: string; updatedAt: string
}
/** Проблема сравнения выписки с базой (привязана к задаче). kind: db_only = операция есть в базе, в выписке нет; account_missing = счёта выписки нет в базе; transfer_unpaired = перевод на свой счёт без возможности создать пару. details: данные для показа. */
export type StatementProblemKind = 'db_only' | 'account_missing' | 'transfer_unpaired' | 'amount_mismatch' | 'date_mismatch'
export interface StatementProblem {
  id: string; taskId: string; kind: StatementProblemKind; status: 'open' | 'resolved'
  transactionId: string | null; details: Json; createdAt: string
}
export interface ImportJob {
  id: string; status: ImportJobStatus
  accounts: ImportJobAccount[]
  packageText: string; contractVersion: number
  /** Принятые ответы чата, решения, итог загрузки. Пустой объект у старых заданий. */
  review: Partial<ImportReviewState>
  createdBy: string | null; createdAt: string; updatedAt: string
}

/** Сущности, которые хранилище читает и пишет целиком (без правил). */
export interface EntityMap {
  appSettings: AppSetting
  planTypes: PlanType
  countries: Country
  currencies: Currency
  institutions: Institution
  projects: Project
  accounts: Account
  accountIdentifiers: AccountIdentifier
  tagGroups: TagGroup
  tags: Tag
  counterparties: Counterparty
  counterpartyIdentifiers: CounterpartyIdentifier
  transactions: Transaction
  checkpoints: BalanceCheckpoint
  periodLocks: PeriodLock
  fxRates: FxRate
  fxSourcePriorities: FxSourcePriority
  importJobs: ImportJob
  statementTasks: StatementTask
  statementProblems: StatementProblem
}
export type EntityName = keyof EntityMap

/** Поле первичного ключа каждой сущности. */
export const PRIMARY_KEY: { [K in EntityName]: keyof EntityMap[K] & string } = {
  appSettings: 'key', planTypes: 'key', countries: 'key', currencies: 'key',
  institutions: 'id', projects: 'id', accounts: 'id', accountIdentifiers: 'id',
  tagGroups: 'id', tags: 'id', counterparties: 'id', counterpartyIdentifiers: 'id',
  transactions: 'id', checkpoints: 'id', periodLocks: 'id', fxRates: 'id',
  fxSourcePriorities: 'source', importJobs: 'id', statementTasks: 'id', statementProblems: 'id',
}
export const ENTITY_NAMES = Object.keys(PRIMARY_KEY) as EntityName[]
