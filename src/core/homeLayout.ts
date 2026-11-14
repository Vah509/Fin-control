// Настройка Главной: какие счета и блоки показывать и в каком порядке. Хранится настройкой `home_layout`
// (входит в выгрузку JSON). Счета, не отмеченные для показа, исключаются с Главной целиком, в том числе из её итогов.
import type { AppSetting, Json } from '../data/types'
import { auditEntry } from './audit'
import type { CoreContext } from './context'
import { fail } from './errors'

export const HOME_KEY = 'home_layout'
export const HOME_BLOCKS = ['rates', 'accounts', 'sections', 'total'] as const
export type HomeBlock = (typeof HOME_BLOCKS)[number]

export interface HomeSettings {
  /** Порядок блоков сверху вниз; всегда содержит все четыре блока по одному разу. */
  order: HomeBlock[]
  /** id счетов, скрытых с Главной. Новые счета показываются сами. */
  hiddenAccounts: string[]
  showTotal: boolean
  showSections: boolean
  showDividers: boolean
}

export const DEFAULT_HOME: HomeSettings = {
  order: [...HOME_BLOCKS], hiddenAccounts: [], showTotal: true, showSections: true, showDividers: true,
}

const isBlock = (x: unknown): x is HomeBlock => (HOME_BLOCKS as readonly unknown[]).includes(x)

/** Приводит любой порядок к полному: лишнее и повторы убираются, недостающие блоки добавляются в конец. */
export function normalizeOrder(order: unknown): HomeBlock[] {
  const out: HomeBlock[] = []
  if (Array.isArray(order)) for (const b of order) if (isBlock(b) && !out.includes(b)) out.push(b)
  for (const b of DEFAULT_HOME.order) if (!out.includes(b)) out.push(b)
  return out
}

/** Читает настройку; всё непонятное заменяется значениями по умолчанию. */
export function readHomeSettings(rows: AppSetting[]): HomeSettings {
  const v = rows.find((r) => r.key === HOME_KEY)?.value
  if (!v || typeof v !== 'object' || Array.isArray(v)) return { ...DEFAULT_HOME, order: [...DEFAULT_HOME.order] }
  const o = v as Record<string, unknown>
  const flag = (k: string, d: boolean) => (typeof o[k] === 'boolean' ? (o[k] as boolean) : d)
  return {
    order: normalizeOrder(o['order']),
    hiddenAccounts: Array.isArray(o['hiddenAccounts']) ? [...new Set(o['hiddenAccounts'].filter((x): x is string => typeof x === 'string'))] : [],
    showTotal: flag('showTotal', true), showSections: flag('showSections', true), showDividers: flag('showDividers', true),
  }
}

/** Сохраняет настройку Главной. Только владелец. */
export async function saveHomeSettings(ctx: CoreContext, next: HomeSettings): Promise<void> {
  if (!ctx.actor.isOwner) fail('FORBIDDEN', 'менять настройки может только владелец')
  const clean: HomeSettings = { ...next, order: normalizeOrder(next.order), hiddenAccounts: [...new Set(next.hiddenAccounts)] }
  const old = readHomeSettings(await ctx.storage.list('appSettings'))
  if (JSON.stringify(old) === JSON.stringify(clean)) return
  await ctx.storage.applyBatch({
    put: { appSettings: [{ key: HOME_KEY, value: clean as unknown as Json }] },
    audit: [auditEntry(ctx, 'setting_changed', { tableName: 'app_settings', recordId: HOME_KEY, oldData: old as unknown as Json, newData: clean as unknown as Json })],
  })
}
