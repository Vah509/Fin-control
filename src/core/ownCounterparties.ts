// Контрагент «свой счёт» для каждого счёта: создаётся вместе со счётом, для старых счетов догоняется при опознании контрагентов выписки.
import type { Account, Counterparty } from '../data/types'
import { auditEntry } from './audit'
import type { CoreContext } from './context'
import { makeKey } from './keys'

const nameKey = (s: string) => s.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase()

/** Новый контрагент «свой счёт» (имя = название счёта; если имя занято, добавляется «(свой счёт)»). */
export function newOwnCounterparty(ctx: CoreContext, acc: Account, existing: Counterparty[]): Counterparty {
  const names = new Set(existing.map((c) => nameKey(c.name)))
  const name = names.has(nameKey(acc.name)) ? `${acc.name} (свой счёт)` : acc.name
  const key = makeKey(name, existing.map((c) => c.key), 'own')
  return { id: ctx.newId(), key, name, kind: 'own_account', accountId: acc.id, defaultTagId: null, defaultPlanType: null }
}

/** Создаёт недостающих контрагентов «свой счёт» для всех счетов (включая архивные). Только владелец. Возвращает число созданных. */
export async function ensureOwnCounterparties(ctx: CoreContext): Promise<number> {
  if (!ctx.actor.isOwner) return 0
  const [accounts, cps] = await Promise.all([ctx.storage.list('accounts'), ctx.storage.list('counterparties')])
  const have = new Set(cps.filter((c) => c.kind === 'own_account' && c.accountId).map((c) => c.accountId))
  const all = [...cps]
  const created: Counterparty[] = []
  for (const a of accounts) {
    if (have.has(a.id)) continue
    const c = newOwnCounterparty(ctx, a, all)
    all.push(c); created.push(c)
  }
  if (!created.length) return 0
  await ctx.storage.applyBatch({
    put: { counterparties: created },
    audit: [auditEntry(ctx, 'own_counterparties_created', { tableName: 'counterparties', details: { count: created.length } })],
  })
  return created.length
}
