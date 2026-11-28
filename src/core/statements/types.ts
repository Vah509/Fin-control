// Модель разобранной выписки. Деньги: целые минорные единицы. Даты: ISO (ГГГГ-ММ-ДД), время ЧЧ:ММ:СС.
export interface PdfTextItem { str: string; x: number; y: number; w: number }
export interface PdfPage { items: PdfTextItem[] }

export type CounterpartyKind = 'card' | 'sepa' | 'other'
export interface StatementCounterparty {
  kind: CounterpartyKind
  /** карта: торговая точка (без даты); SEPA: «Názov protiúčtu»; иное: заголовок операции */
  name: string
  /** SEPA: IBAN контрагента без пробелов */
  iban: string | null
  /** перевод между своими картами: последние 4 цифры другой карты (опознано разбором выписки) */
  ownLast4?: string
}

export interface StatementRow {
  /** сквозной номер строки в выписке (с 1) */
  n: number
  /** 4 последние цифры IBAN счёта */
  accountKey: string
  valueDate: string
  bookingDate: string
  /** время карточной операции из описания; у SEPA null */
  time: string | null
  title: string
  counterparty: StatementCounterparty
  /** маска карты («4544 12** **** 4324») или null */
  cardMask: string | null
  /** категория банка (ПриватБанк), иначе не задана */
  category?: string
  /** полный исходный текст операции одной строкой */
  description: string
  amountMinor: number
  /** «Suma poplatku» со знаком, 0 если пусто */
  feeMinor: number
  balanceAfterMinor: number
  currency: string
}

export interface StatementAccount {
  /** IBAN без пробелов */
  number: string
  key: string
  title: string
  holderName: string
  currency: string
  periodStart: string
  periodEnd: string
  openingMinor: number
  closingMinor: number
  depositsMinor: number
  /** по модулю (в шапке со знаком минус) */
  withdrawalsMinor: number
  rows: StatementRow[]
}

export interface ParsedStatement { bank: 'slsp' | 'privat'; accounts: StatementAccount[] }

export interface Reconciliation {
  accountKey: string
  ok: boolean
  rowCount: number
  /** номера строк, где цепочка остатков не сошлась */
  badRows: number[]
  firstBadRow: number | null
  openingMinor: number
  closingExpectedMinor: number
  closingComputedMinor: number
  depositsExpectedMinor: number
  depositsComputedMinor: number
  withdrawalsExpectedMinor: number
  withdrawalsComputedMinor: number
}

/** Решения владельца по проблемам задачи (хранятся в state задачи). Сравнение учитывает их при каждом пересчёте. */
export interface StatementDecisions {
  /** db_only «оставить»: id операций базы */
  keepDb?: string[]
  /** amount_mismatch «оставить базу»: строка выписки n счёта a считается совпавшей с операцией tx */
  keepBase?: { a: string; n: number; tx: string }[]
  /** amount_mismatch «разные операции»: эту пару не связывать */
  distinct?: { a: string; n: number; tx: string }[]
  /** transfer_unpaired «обычный расход/приход»: строка пишется без пары */
  plain?: { a: string; n: number }[]
}
