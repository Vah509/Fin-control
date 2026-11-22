// Запись операций выписки в базу (кнопка «Готово», только когда нет проблем). Строки, которых уже есть в базе (по сравнению), не пишутся.
// Время в базе: 12:00 по поясу счёта плюс номер строки в секундах (порядок внутри дня; во времени смысла нет, решение владельца).
// Перевод на свой счёт: две записи (эта сторона и парная на счёте-получателе) с общим transfer_id; в других случаях это проблема и запись не идёт.
import type { Account, Transaction, TransactionType } from '../../data/types'
import type { CoreContext } from '../context'
import { fail } from '../errors'
import { assertUnlocked } from '../locks'
import { readSettings, resolveTimeZone } from '../settings'
import { iso, startOfLocalDayMs } from '../time'
import { checkTransactionShape } from '../transactions'
import { cmpKey, findDbAccount, pairTarget, rowCounterparties, type Comparison } from './compare'
import type { ParsedStatement } from './types'

const HOUR = 3_600_000

/** Операции к записи по выписке и сравнению (без проблем). Проверяет форму и закрытые периоды (по одному разу на счёт). */
export async function buildStatementTransactions(ctx: CoreContext, st: ParsedStatement, cmp: Comparison): Promise<Transaction[]> {
  const s = ctx.storage
  const accounts = await s.list('accounts')
  const ids = await s.listAccountIdentifiers()
  const countries = await s.list('countries')
  const settings = readSettings(await s.list('appSettings'))
  const cps = await s.list('counterparties')
  const cpOf = await rowCounterparties(ctx, st)
  const now = ctx.now().toISOString()
  const out: Transaction[] = []
  const earliest = new Map<string, { acc: Account; at: string }>()
  const mk = (acc: Account, date: string, n: number, type: TransactionType, amountMinor: number, counterpartyId: string | null, transferId: string | null, description: string): Transaction => {
    const bookedAt = iso(startOfLocalDayMs(date, resolveTimeZone(acc, countries, settings)) + 12 * HOUR + n * 1000)
    const e = earliest.get(acc.id)
    if (!e || bookedAt < e.at) earliest.set(acc.id, { acc, at: bookedAt })
    const t: Transaction = {
      id: ctx.newId(), accountId: acc.id, counterpartyId, importId: null, source: 'import', bookedAt, type, amountMinor, currencyKey: acc.currencyKey,
      originalAmountMinor: null, originalCurrencyKey: null, tagId: null, planType: null, comment: null, transferId, dedupeHash: null, deletedAt: null,
      isOpening: false, raw: { n, description }, createdBy: ctx.actor.userId, createdAt: now, updatedAt: now,
    }
    checkTransactionShape(t, acc)
    if (acc.archivedAt) fail('ACCOUNT_ARCHIVED', `счёт «${acc.name}» архивный`)
    return t
  }

  for (const a of st.accounts) {
    const dbAcc = findDbAccount(accounts, ids, a) ?? fail('NOT_FOUND', `счёт …${a.key} не найден в базе`)
    for (const r of a.rows) {
      if (!cmp.inDb[cmpKey(a.key, r.n, 'operation')]) {
        const cp = cpOf(r.counterparty)
        const pt = pairTarget(accounts, cp, dbAcc)
        if (pt && !pt.ok) fail('INVALID_FIELD', `строка ${r.n}: ${pt.reason}`)
        if (pt?.ok) {
          const transferId = ctx.newId()
          const own = cps.find((c) => c.kind === 'own_account' && c.accountId === dbAcc.id)
          out.push(mk(dbAcc, r.bookingDate, r.n, 'transfer', r.amountMinor, cp!.id, transferId, r.description))
          out.push(mk(pt.target, r.bookingDate, r.n, 'transfer', -r.amountMinor, own?.id ?? null, transferId, r.description))
        } else {
          out.push(mk(dbAcc, r.bookingDate, r.n, r.amountMinor > 0 ? 'income' : 'expense', r.amountMinor, cp?.id ?? null, null, r.description))
        }
      }
      if (r.feeMinor !== 0 && !cmp.inDb[cmpKey(a.key, r.n, 'fee')]) {
        out.push(mk(dbAcc, r.bookingDate, r.n, r.feeMinor < 0 ? 'fee' : 'income', r.feeMinor, null, null, `Комиссия за операцию №${r.n}`))
      }
    }
  }
  for (const { acc, at } of earliest.values()) await assertUnlocked(ctx, acc, at)
  return out
}
