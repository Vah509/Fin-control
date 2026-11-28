// Выписки как документы (docs/STATEMENT-DOCS.md, этап 1): сохранение разобранной выписки без записи операций в учёт,
// проверка дублей по ключу строки, удаление документа, XLSX документа. Встраивание в учёт: этап 2.
import type { Json, StatementDocAccount, StatementDocRow, StatementDocument, StatementTask } from '../data/types'
import { auditEntry } from './audit'
import type { CoreContext } from './context'
import { fail } from './errors'
import { readSettings } from './settings'
import { findDbAccount, rowCounterparties } from './statements/compare'
import { reconcileAccount } from './statements/reconcile'
import { statementBookedAt } from './statements/write'
import type { ParsedStatement } from './statements/types'
import { getTask, recordCounterpartyUpload, taskStatement, type StatementTaskState } from './statementTasks'
import { counterpartyStatus } from './statements/counterparties'

async function sha256Hex(text: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('')
}
const norm = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase()

/** Хэш разобранного содержимого выписки (файл не хранится): тот же разбор загрузить второй раз нельзя. */
export async function statementContentHash(st: ParsedStatement): Promise<string> {
  return sha256Hex(JSON.stringify(st.accounts.map((a) => [a.key, a.periodStart, a.periodEnd, a.openingMinor, a.closingMinor,
    a.rows.map((r) => [r.bookingDate, r.amountMinor, r.feeMinor, norm(r.description)])])))
}

/** Ключ строки: счёт, дата, сумма, комиссия, валюта, описание и номер среди одинаковых. Не зависит от номера строки в выписке. */
export async function rowKeyOf(accountId: string, bookingDate: string, amountMinor: number, feeMinor: number, currency: string, description: string, nth: number): Promise<string> {
  return sha256Hex(`${accountId}|${bookingDate}|${amountMinor}|${feeMinor}|${currency}|${norm(description)}|${nth}`)
}

export interface SaveDocumentResult { document: StatementDocument; rows: number; duplicates: number }

/**
 * «Сохранить выписку»: превращает задачу (шаги 1-3 пройдены) в документ. Операции в учёт НЕ пишутся.
 * Отказ: то же содержимое уже есть; все строки уже есть в других документах. Часть строк есть: документ сохраняется,
 * у дублей duplicateOf указывает на уже существующую строку.
 */
export async function saveStatementFromTask(ctx: CoreContext, taskId: string): Promise<SaveDocumentResult> {
  if (!ctx.actor.isOwner) fail('FORBIDDEN', 'сохранять выписки может только владелец')
  const t: StatementTask = await getTask(ctx, taskId)
  if (t.status === 'done') fail('INVALID_FIELD', 'задача уже закрыта')
  const s = t.state as StatementTaskState
  if (!s.counterpartiesLoaded) fail('INVALID_FIELD', 'сначала пройдите шаги 2 и 3 (счета и контрагенты)')
  const st = taskStatement(t)
  const bad = st.accounts.filter((a) => !reconcileAccount(a).ok)
  if (bad.length) fail('RECONCILE_FAILED', `сверка выписки не сошлась (счёт …${bad.map((a) => a.key).join(', …')}), сохранение невозможно`)

  const store = ctx.storage
  const contentHash = await statementContentHash(st)
  const docs = await store.list('statementDocuments')
  if (docs.some((d) => d.contentHash === contentHash)) fail('DUPLICATE_STATEMENT', 'эта выписка уже сохранена')

  const accounts = await store.list('accounts')
  const ids = await store.listAccountIdentifiers()
  const countries = await store.list('countries')
  const settings = readSettings(await store.list('appSettings'))
  const cpOf = await rowCounterparties(ctx, st)
  const existing = new Map<string, string>()
  for (const r of [...(await store.list('statementRows'))].sort((a, b) => a.bookedAt.localeCompare(b.bookedAt))) {
    if (!existing.has(`${r.accountId}|${r.rowKey}`)) existing.set(`${r.accountId}|${r.rowKey}`, r.id)
  }

  const now = ctx.now().toISOString()
  const docId = ctx.newId()
  const docAccounts: StatementDocAccount[] = []
  const docRows: StatementDocRow[] = []
  let duplicates = 0
  for (const a of st.accounts) {
    const dbAcc = findDbAccount(accounts, ids, a) ?? fail('NOT_FOUND', `счёт …${a.key} не найден в базе`)
    const saId = ctx.newId()
    const seen = new Map<string, number>()
    for (const r of a.rows) {
      const base = `${r.bookingDate}|${r.amountMinor}|${r.feeMinor}|${norm(r.description)}`
      const nth = (seen.get(base) ?? 0) + 1
      seen.set(base, nth)
      const rowKey = await rowKeyOf(dbAcc.id, r.bookingDate, r.amountMinor, r.feeMinor, a.currency, r.description, nth)
      const dup = existing.get(`${dbAcc.id}|${rowKey}`) ?? null
      if (dup) duplicates++
      docRows.push({
        id: ctx.newId(), documentId: docId, statementAccountId: saId, accountId: dbAcc.id, n: r.n,
        bookedAt: statementBookedAt(dbAcc, r.bookingDate, r.n, countries, settings), valueDate: r.valueDate,
        amountMinor: r.amountMinor, feeMinor: r.feeMinor, balanceAfterMinor: r.balanceAfterMinor,
        counterpartyId: cpOf(r.counterparty)?.id ?? null, title: r.title, description: r.description, cardMask: r.cardMask, rowKey, duplicateOf: dup,
      })
    }
    docAccounts.push({
      id: saId, documentId: docId, accountId: dbAcc.id, periodStart: a.periodStart, periodEnd: a.periodEnd,
      openingMinor: a.openingMinor, closingMinor: a.closingMinor, incomeMinor: a.depositsMinor, expenseMinor: a.withdrawalsMinor,
      rowCount: a.rows.length, builtInAt: null,
    })
  }
  if (docRows.length > 0 && duplicates === docRows.length) fail('DUPLICATE_STATEMENT', 'записано не будет: все строки уже есть в сохранённых выписках')

  const starts = st.accounts.map((a) => a.periodStart).sort()
  const ends = st.accounts.map((a) => a.periodEnd).sort()
  const document: StatementDocument = {
    id: docId, kind: 'statement', institutionId: accounts.find((x) => x.id === docAccounts[0]?.accountId)?.institutionId ?? null, bank: st.bank,
    fileName: t.fileName, contentHash, periodStart: starts[0] ?? null, periodEnd: ends[ends.length - 1] ?? null, parser: `${st.bank}-pdf`,
    createdBy: ctx.actor.userId, createdAt: now,
  }
  const next: StatementTask = { ...t, status: 'done', state: { ...s, operationsDone: true, writtenCount: 0, documentId: docId, savedAt: now, savedRows: docRows.length, savedDuplicates: duplicates } as unknown as Json, updatedAt: now }
  await store.applyBatch({
    put: { statementDocuments: [document], statementAccounts: docAccounts, statementRows: docRows, statementTasks: [next] },
    audit: [auditEntry(ctx, 'statement_saved', { tableName: 'statement_documents', recordId: docId, details: { rows: docRows.length, duplicates, accounts: st.accounts.map((a) => a.key) } })],
  })
  return { document, rows: docRows.length, duplicates }
}

/** Удаление документа со счетами и строками. Встроенный в учёт документ сначала нужно убрать из учёта (этап 2). */
export async function deleteStatementDocument(ctx: CoreContext, documentId: string): Promise<void> {
  if (!ctx.actor.isOwner) fail('FORBIDDEN', 'удалять выписки может только владелец')
  const accs = (await ctx.storage.list('statementAccounts')).filter((a) => a.documentId === documentId)
  if (accs.some((a) => a.builtInAt)) fail('DOCUMENT_BUILT_IN', 'выписка встроена в учёт: сначала уберите её из учёта')
  await ctx.storage.applyBatch({
    deleteStatementDocumentIds: [documentId],
    audit: [auditEntry(ctx, 'statement_document_deleted', { tableName: 'statement_documents', recordId: documentId, details: {} })],
  })
}

/** Имя файла XLSX документа: <банк>_<ГГГГ-ММ>.xlsx (месяц конца периода). */
export const documentFileName = (d: StatementDocument) => `${d.bank || 'statement'}_${(d.periodEnd ?? '').slice(0, 7)}.xlsx`

/** XLSX документа: листы «Операции» и «Сверка» (стандартный формат, docs/STATEMENT-XLSX.md). Колонка «Дубль» отмечает строки с duplicateOf. */
export async function buildDocumentWorkbook(ctx: CoreContext, documentId: string): Promise<Uint8Array> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ExcelJS: any = await import('exceljs').then((m: any) => m.default ?? m).catch(() => fail('INVALID_FIELD', 'Не удалось загрузить модуль Excel. Закройте приложение полностью и откройте снова'))
  const store = ctx.storage
  const accs = (await store.list('statementAccounts')).filter((a) => a.documentId === documentId)
  const rows = (await store.list('statementRows')).filter((r) => r.documentId === documentId).sort((a, b) => a.n - b.n)
  const dbAccs = await store.list('accounts')
  const cps = new Map((await store.list('counterparties')).map((c) => [c.id, c.name]))
  const cur = new Map(dbAccs.map((a) => [a.id, a.currencyKey.toUpperCase()]))
  const accName = new Map(dbAccs.map((a) => [a.id, a.name]))
  const money = (m: number | null) => (m === null ? '' : m / 100)

  const wb = new ExcelJS.Workbook()
  const ws = wb.addWorksheet('Операции')
  ws.columns = ['№', 'Дата', 'Время', 'Счёт', 'Контрагент', 'Сумма', 'Валюта', 'Остаток после', 'Описание из выписки', 'Дубль'].map((header, i) => ({ header, width: [6, 11, 7, 22, 32, 14, 9, 16, 70, 7][i] }))
  const mk = (n: number, r: StatementDocRow, cp: string, amount: number, after: number | null, desc: string) => {
    const row = ws.addRow([n, new Date(`${r.bookedAt.slice(0, 10)}T00:00:00Z`), '', accName.get(r.accountId) ?? '', cp, money(amount), cur.get(r.accountId) ?? '', money(after), desc, r.duplicateOf ? '+' : ''])
    row.getCell(2).numFmt = 'DD.MM.YYYY'; row.getCell(6).numFmt = '#,##0.00'; row.getCell(8).numFmt = '#,##0.00'
  }
  for (const r of rows) {
    mk(r.n, r, r.counterpartyId ? (cps.get(r.counterpartyId) ?? r.title ?? '') : (r.title ?? ''), r.amountMinor, r.balanceAfterMinor === null ? null : r.balanceAfterMinor - r.feeMinor, r.description)
    if (r.feeMinor !== 0) mk(r.n, r, 'Комиссия банка', r.feeMinor, r.balanceAfterMinor, `Комиссия за операцию №${r.n}`)
  }
  const rs = wb.addWorksheet('Сверка')
  rs.columns = ['Счёт', 'Название', 'Валюта', 'Период с', 'Период по', 'Остаток на начало', 'Остаток на конец', 'Приход', 'Расход', 'Строк'].map((header, i) => ({ header, width: [8, 28, 9, 12, 12, 18, 18, 14, 14, 8][i] }))
  for (const a of accs) {
    const row = rs.addRow([a.accountId.slice(-4), accName.get(a.accountId) ?? '', cur.get(a.accountId) ?? '', a.periodStart ? new Date(`${a.periodStart}T00:00:00Z`) : '', a.periodEnd ? new Date(`${a.periodEnd}T00:00:00Z`) : '',
      money(a.openingMinor), money(a.closingMinor), money(a.incomeMinor), money(a.expenseMinor), a.rowCount])
    for (const c of [4, 5]) row.getCell(c).numFmt = 'DD.MM.YYYY'
    for (let c = 6; c <= 9; c++) row.getCell(c).numFmt = '#,##0.00'
  }
  for (const w of [ws, rs]) { w.getRow(1).font = { bold: true }; w.views = [{ state: 'frozen', ySplit: 1 }] }
  return new Uint8Array((await wb.xlsx.writeBuffer()) as ArrayBuffer)
}

/** Шаг 3 без файла: все контрагенты выписки уже опознаны, сразу к шагу 4. Иначе отказ. */
export async function confirmCounterpartiesRecognized(ctx: CoreContext, taskId: string): Promise<StatementTask> {
  if (!ctx.actor.isOwner) fail('FORBIDDEN', 'шаг выполняет только владелец')
  const t = await getTask(ctx, taskId)
  const st = taskStatement(t)
  const c = await counterpartyStatus(ctx, st)
  if (c.unrecognized.length > 0) fail('INVALID_FIELD', `не опознано контрагентов: ${c.unrecognized.length}, нужен файл контрагентов`)
  const rows = st.accounts.reduce((n, a) => n + a.rows.length, 0)
  return recordCounterpartyUpload(ctx, taskId, 'без файла: все опознаны', { rows, created: 0, identifiersAdded: 0, reassigned: 0 })
}
