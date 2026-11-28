// Помощники выписок: опознание счёта выписки в базе, цель парного перевода, контрагенты строк.
// (Старое сравнение выписки с учётом удалено в 0.2.40: выписки теперь документы, встраивание: src/core/statementBuild.ts.)
import type { Account, Counterparty } from '../../data/types'
import type { CoreContext } from '../context'
import { collectCounterpartyGroups, groupKeyOf, recognizeGroups } from './counterparties'
import type { ParsedStatement, StatementAccount } from './types'

const isActive = (v: { validFrom: string; validTo: string | null }, d: string) => v.validFrom <= d && d <= (v.validTo ?? '9999-12-31')

export function findDbAccount(accounts: Account[], ids: { accountId: string; kind: string; last4: string | null; validFrom: string; validTo: string | null }[], acc: StatementAccount): Account | null {
  const hit = new Set(ids.filter((i) => i.kind === 'account_number' && i.last4 === acc.key && isActive(i, acc.periodEnd)).map((i) => i.accountId))
  if (hit.size !== 1) return null
  const a = accounts.find((x) => x.id === [...hit][0])
  return a && a.currencyKey.toUpperCase() === acc.currency.toUpperCase() ? a : null
}

/** Перевод на свой счёт: null = не перевод; ok = счёт-получатель в базе, та же валюта, не архивный (парная запись создаётся сразу). */
export function pairTarget(accounts: Account[], cp: Counterparty | null, from: Account): { ok: true; target: Account } | { ok: false; reason: string } | null {
  if (!cp || cp.kind !== 'own_account') return null
  const target = cp.accountId ? accounts.find((a) => a.id === cp.accountId) : undefined
  if (!target) return { ok: false, reason: `контрагент «${cp.name}» не привязан к счёту в базе` }
  if (target.id === from.id) return { ok: false, reason: 'перевод на тот же счёт' }
  if (target.archivedAt) return { ok: false, reason: `счёт «${target.name}» архивный` }
  if (target.currencyKey !== from.currencyKey) return { ok: false, reason: `разная валюта (${from.currencyKey.toUpperCase()} → ${target.currencyKey.toUpperCase()}), парная запись пока не создаётся` }
  return { ok: true, target }
}

/** Опознанный контрагент строки выписки (по справочнику на сегодня) или null. */
export async function rowCounterparties(ctx: CoreContext, st: ParsedStatement): Promise<(c: { name: string; iban: string | null; ownLast4?: string }) => Counterparty | null> {
  const groups = collectCounterpartyGroups(st)
  const found = await recognizeGroups(ctx, groups)
  const map = new Map<string, Counterparty | null>()
  groups.forEach((g, i) => map.set(groupKeyOf({ name: g.text, iban: g.iban, ownLast4: g.ownLast4 }), found[i] ?? null))
  return (c) => map.get(groupKeyOf(c)) ?? null
}
