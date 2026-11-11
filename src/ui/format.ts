// Тексты ошибок, форматирование денег и дат для экранов. Без обращения к хранилищу.
import { CoreError, formatMinor, parseMinor, type ErrorCode } from '../core'

const ERR: Record<ErrorCode, string> = {
  PERIOD_LOCKED: 'Период закрыт, запись менять нельзя',
  PERIOD_NOT_AFTER_LOCK: 'Новая дата закрытия должна быть позже текущей',
  NOTHING_TO_REOPEN: 'Нечего открывать',
  CHECKPOINT_MISMATCH: 'Есть расхождения с контрольными точками',
  INVALID_AMOUNT: 'Некорректная сумма',
  INVALID_SIGN: 'Знак суммы не подходит к типу операции',
  INVALID_DATE: 'Некорректная дата',
  INVALID_TIMEZONE: 'Не удалось определить часовой пояс',
  INVALID_ORIGINAL: 'Некорректные исходные сумма и валюта',
  INVALID_FIELD: 'Некорректное значение',
  CURRENCY_MISMATCH: 'Валюта не совпадает с валютой счёта',
  ACCOUNT_ARCHIVED: 'Счёт в архиве, операции не принимаются',
  OPENING_EXISTS: 'У счёта уже есть начальный остаток',
  OPENING_NOT_ADJUSTMENT: 'Начальным может быть только остаток-корректировка',
  NOT_FOUND: 'Не найдено',
  FORBIDDEN: 'Недостаточно прав',
  DUPLICATE_KEY: 'Такой ключ уже есть',
  CURRENCY_LOCKED: 'Валюту счёта с операциями менять нельзя',
  IDENTIFIER_OVERLAP: 'Признак уже принадлежит другому счёту',
  IDENTIFIER_INVALID_RANGE: 'Некорректный срок действия признака',
  CRYPTO_UNAVAILABLE: 'Шифрование недоступно',
  NO_RATE: 'Нет курса на эту дату',
}

export function errorText(e: unknown): string {
  if (e instanceof CoreError) {
    const detail = e.message.replace(/^[A-Z_]+: /, '')
    const base = ERR[e.code]
    return detail && detail !== base ? `${base}. ${detail}` : base
  }
  const msg = e instanceof Error ? e.message : String(e)
  if (/Invalid login credentials/i.test(msg)) return 'Неверная почта или пароль'
  if (msg.startsWith('AUTH: ')) return msg.slice(6)
  if (msg.startsWith('CONFIG: ')) return msg.slice(8)
  if (msg.startsWith('STORAGE: ')) return `Ошибка базы данных. ${msg.slice(9)}`
  if (/Failed to fetch|NetworkError|Load failed/i.test(msg)) return 'Нет связи с сервером. Запись возможна только онлайн'
  return msg
}

/** 124558 -> «1 245,58»; минус настоящий «−». */
export function money(minor: number, decimals: number): string {
  const s = formatMinor(minor, decimals)
  const neg = s.startsWith('-')
  const [int = '0', frac] = s.replace('-', '').split('.')
  const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, '\u00a0')
  return (neg ? '−' : '') + grouped + (frac ? ',' + frac : '')
}

export type AmountParse = { minor: number } | { error: string } | null

/** Ввод суммы: запятая как точка, пробелы игнорируются. Пустая строка = null. */
export function parseAmountInput(text: string, decimals: number): AmountParse {
  const t = text.trim().replace(/[\s\u00a0]/g, '').replace(',', '.').replace('−', '-')
  if (t === '') return null
  try {
    return { minor: parseMinor(t, decimals) }
  } catch (e) {
    return { error: errorText(e) }
  }
}

const p2 = (n: number) => String(n).padStart(2, '0')

/** Сегодняшняя дата в часовом поясе устройства: ГГГГ-ММ-ДД. */
export function todayLocal(d = new Date()): string {
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`
}
/** Значение для input type=datetime-local. */
export function toLocalInput(d = new Date()): string {
  return `${todayLocal(d)}T${p2(d.getHours())}:${p2(d.getMinutes())}`
}
/** Значение datetime-local (местное время устройства) -> ISO UTC; null если пусто или некорректно. */
export function localInputToIso(v: string): string | null {
  const ms = Date.parse(v)
  return Number.isNaN(ms) ? null : new Date(ms).toISOString()
}
/** ГГГГ-ММ-ДД -> ДД.ММ.ГГГГ */
export function dateRu(date: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(date)
  return m ? `${m[3]}.${m[2]}.${m[1]}` : date
}
export function dateTimeRu(isoStr: string): string {
  const d = new Date(isoStr)
  return Number.isNaN(d.getTime()) ? isoStr : `${p2(d.getDate())}.${p2(d.getMonth() + 1)}.${d.getFullYear()} ${p2(d.getHours())}:${p2(d.getMinutes())}`
}
/** Последний день прошлого месяца: разумная дата закрытия по умолчанию. */
export function lastDayOfPreviousMonth(d = new Date()): string {
  return todayLocal(new Date(d.getFullYear(), d.getMonth(), 0))
}
