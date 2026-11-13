// Раскладка счетов в разделе с разделителями (тонкие полосы для визуального деления списка).
// Разделитель это не счёт: без остатка и валюты, в расчётах не участвует. Хранится в настройке `account_layout`:
// { id раздела: [id счетов и разделителей сверху вниз] }. Запись есть только у разделов, где есть разделители;
// без разделителей порядок задаёт sortOrder счетов.
import type { Account, AppSetting, Json } from '../data/types'
import { auditEntry } from './audit'
import type { CoreContext } from './context'
import { fail } from './errors'

export const LAYOUT_KEY = 'account_layout'
export const DIVIDER_PREFIX = 'div:'
export type Layout = Record<string, string[]>

export const isDivider = (id: string): boolean => id.startsWith(DIVIDER_PREFIX)
export const newDividerId = (ctx: CoreContext): string => DIVIDER_PREFIX + ctx.newId()

/** Читает настройку; всё, что не похоже на { строка: [строки] }, отбрасывает. */
export function readLayout(rows: AppSetting[]): Layout {
  const v = rows.find((r) => r.key === LAYOUT_KEY)?.value
  const out: Layout = {}
  if (!v || typeof v !== 'object' || Array.isArray(v)) return out
  for (const [pid, list] of Object.entries(v as Record<string, unknown>)) {
    if (Array.isArray(list)) out[pid] = list.filter((x): x is string => typeof x === 'string')
  }
  return out
}

/**
 * Порядок элементов раздела: сохранённая раскладка (без исчезнувших счетов и повторов), затем счета,
 * которых в раскладке нет (новые, перенесённые, возвращённые из архива), по sortOrder.
 * `accounts`: действующие (не архивные) счета раздела в порядке sortOrder.
 */
export function projectItems(layout: Layout, projectId: string, accounts: Account[]): string[] {
  const ids = new Set(accounts.map((a) => a.id))
  const seen = new Set<string>()
  const out: string[] = []
  for (const id of layout[projectId] ?? []) {
    if (seen.has(id)) continue
    if (isDivider(id) || ids.has(id)) { out.push(id); seen.add(id) }
  }
  for (const a of accounts) if (!seen.has(a.id)) out.push(a.id)
  return out
}

/** Для показа вне режима порядка: разделители в начале, в конце и подряд не показываются. */
export function visibleItems(items: string[]): string[] {
  const out: string[] = []
  for (const id of items) {
    if (isDivider(id) && (out.length === 0 || isDivider(out[out.length - 1]!))) continue
    out.push(id)
  }
  while (out.length && isDivider(out[out.length - 1]!)) out.pop()
  return out
}

/**
 * Сохраняет порядок счетов и разделителей раздела. Порядок счетов попадает в sortOrder (архивные в конец),
 * раскладка с разделителями в настройку; одним пакетом. Только владелец.
 */
export async function saveProjectLayout(ctx: CoreContext, projectId: string, items: string[]): Promise<void> {
  if (!ctx.actor.isOwner) fail('FORBIDDEN', 'менять порядок может только владелец')
  const [accounts, settings] = await Promise.all([ctx.storage.list('accounts'), ctx.storage.list('appSettings')])
  const inProject = accounts.filter((a) => a.projectId === projectId)
  const active = inProject.filter((a) => !a.archivedAt)
  const accIds = items.filter((id) => !isDivider(id))
  const dividers = items.filter(isDivider)
  if (accIds.length !== active.length || new Set(accIds).size !== active.length || !active.every((a) => accIds.includes(a.id))) {
    fail('INVALID_FIELD', 'в порядке должны быть все действующие счета раздела по одному разу')
  }
  if (new Set(dividers).size !== dividers.length) fail('INVALID_FIELD', 'повторяющийся разделитель')

  const archived = inProject.filter((a) => a.archivedAt).sort((a, b) => a.sortOrder - b.sortOrder || a.key.localeCompare(b.key))
  const order = [...accIds, ...archived.map((a) => a.id)]
  const byId = new Map(inProject.map((a) => [a.id, a]))
  const changed = order.map((id, i) => ({ ...byId.get(id)!, sortOrder: i })).filter((a) => a.sortOrder !== byId.get(a.id)!.sortOrder)

  const layout = readLayout(settings)
  const next: Layout = { ...layout }
  if (dividers.length) next[projectId] = items; else delete next[projectId]
  const layoutSame = JSON.stringify(layout[projectId] ?? null) === JSON.stringify(next[projectId] ?? null)
  if (!changed.length && layoutSame) return

  await ctx.storage.applyBatch({
    put: { accounts: changed, appSettings: [{ key: LAYOUT_KEY, value: next as unknown as Json }] },
    audit: [auditEntry(ctx, 'layout_changed', { tableName: 'app_settings', recordId: LAYOUT_KEY, details: { projectId, items } })],
  })
}
