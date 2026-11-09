// Коды ошибок одинаковы при любом хранилище. Сообщение начинается с кода.
export type ErrorCode =
  | 'PERIOD_LOCKED' | 'PERIOD_NOT_AFTER_LOCK' | 'NOTHING_TO_REOPEN' | 'CHECKPOINT_MISMATCH'
  | 'INVALID_AMOUNT' | 'INVALID_SIGN' | 'INVALID_DATE' | 'INVALID_TIMEZONE' | 'INVALID_ORIGINAL'
  | 'INVALID_FIELD' | 'CURRENCY_MISMATCH' | 'ACCOUNT_ARCHIVED' | 'OPENING_EXISTS' | 'OPENING_NOT_ADJUSTMENT'
  | 'NOT_FOUND' | 'FORBIDDEN' | 'DUPLICATE_KEY' | 'CURRENCY_LOCKED'
  | 'IDENTIFIER_OVERLAP' | 'IDENTIFIER_INVALID_RANGE' | 'CRYPTO_UNAVAILABLE' | 'NO_RATE'

export class CoreError extends Error {
  constructor(public readonly code: ErrorCode, message: string, public readonly details?: Record<string, unknown>) {
    super(`${code}: ${message}`)
    this.name = 'CoreError'
  }
}
export const fail = (code: ErrorCode, message: string, details?: Record<string, unknown>): never => {
  throw new CoreError(code, message, details)
}
