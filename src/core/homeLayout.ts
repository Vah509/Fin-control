// Настройка Главной (ключ `home_layout`, входит в выгрузку JSON). У каждого блока свои настройки; сейчас блоки:
// курсы, счета, общий итог. Счета на Главной имеют СВОИ порядок разделов, порядок счетов и разделители,
// независимо от экрана «Счета». Счёт, снятый с показа, не отображается на Главной и не входит в её итоги.
import type { AppSetting, Json } from '../data/types'
import { auditEntry } from './audit'
import type { CoreContext } from './context'
import { fail } from './errors'
import type { Layout } from './layout'

export const HOME_KEY = 'home_layout'
export const HOME_BLOCKS = ['rates', 'accounts', 'total'] as const
export type HomeBlock = (typeof HOME_BLOCKS)[number]

export interface HomeSettings {
  /** Порядок блоков сверху вниз; всегда все блоки по одному разу. */
  order: HomeBlock[]
  showRates: boolean
  showAccounts: boolean
  showTotal: boolean
  /** Блок «Счета»: id счетов, скрытых с Главной (новые счета показываются сами). */
  hiddenAccounts: string[]
  /** Блок «Счета»: сумма раздела справа от его названия. */
  showSectionTotals: boolean
  /** Блок «Счета»: разделители между счетами. */
  showDividers: boolean
  /** Блок «Счета»: свой порядок разделов (id); не названные идут после, в порядке экрана «Счета». */
  projectOrder: string[]
  /** Блок «Счета»: свой порядок счетов и разделителей по разделам { id раздела: [id счетов и разделителей] }. */
  layout: Layout
}

export const DEFAULT_HOME: HomeSettings = {
  order: [...HOME_BLOCKS], showRates: true, showAccounts: true, showTotal: true,
  hiddenAccounts: [], showSectionTotals: true, showDividers: true, projectOrder: [], layout: {},
}

export const freshHome = (): HomeSettings => ({ ...DEFAULT_HOME, order: [...DEFAULT_HOME.order], hiddenAccounts: [], projectOrder: [], layout: {} })

const isBlock = (x: unknown): x is HomeBlock => (HOME_BLOCKS as readonly unknown[]).includes(x)
const strings = (v: unknown): string[] => (Array.isArray(v) ? [...new Set(v.filter((x): x is string => typeof x === 'string'))] : [])

/** Приводит любой порядок к полному: лишнее (и блок «sections» старой версии) и повторы убираются, недостающие добавляются в конец. */
export function normalizeOrder(order: unknown): HomeBlock[] {
  const out: HomeBlock[] = []
  if (Array.isArray(order)) for (const b of order) if (isBlock(b) && !out.includes(b)) out.push(b)
  for (const b of DEFAULT_HOME.order) if (!out.includes(b)) out.push(b)
  return out
}

function cleanLayout(v: unknown): Layout {
  const out: Layout = {}
  if (!v || typeof v !== 'object' || Array.isArray(v)) return out
  for (const [pid, list] of Object.entries(v as Record<string, unknown>)) {
    if (Array.isArray(list)) out[pid] = list.filter((x): x is string => typeof x === 'string')
  }
  return out
}

/** Читает настройку; всё непонятное заменяется значениями по умолчанию. Понимает и первую версию (с `showSections`). */
export function readHomeSettings(rows: AppSetting[]): HomeSettings {
  const v = rows.find((r) => r.key === HOME_KEY)?.value
  if (!v || typeof v !== 'object' || Array.isArray(v)) return freshHome()
  const o = v as Record<string, unknown>
  const flag = (k: string, d: boolean) => (typeof o[k] === 'boolean' ? (o[k] as boolean) : d)
  return {
    order: normalizeOrder(o['order']),
    showRates: flag('showRates', true), showAccounts: flag('showAccounts', true), showTotal: flag('showTotal', true),
    hiddenAccounts: strings(o['hiddenAccounts']),
    showSectionTotals: flag('showSectionTotals', flag('showSections', true)),
    showDividers: flag('showDividers', true),
    projectOrder: strings(o['projectOrder']),
    layout: cleanLayout(o['layout']),
  }
}

/** Разделы в порядке Главной: сначала названные в `order`, затем остальные в исходном порядке. */
export function orderProjects<T extends { id: string }>(order: string[], projects: T[]): T[] {
  const byId = new Map(projects.map((p) => [p.id, p]))
  const out: T[] = []
  for (const id of order) { const p = byId.get(id); if (p && !out.includes(p)) out.push(p) }
  for (const p of projects) if (!out.includes(p)) out.push(p)
  return out
}

/** Сохраняет настройку Главной. Только владелец. */
export async function saveHomeSettings(ctx: CoreContext, next: HomeSettings): Promise<void> {
  if (!ctx.actor.isOwner) fail('FORBIDDEN', 'менять настройки может только владелец')
  const clean: HomeSettings = {
    ...next, order: normalizeOrder(next.order), hiddenAccounts: strings(next.hiddenAccounts),
    projectOrder: strings(next.projectOrder), layout: cleanLayout(next.layout),
  }
  const old = readHomeSettings(await ctx.storage.list('appSettings'))
  if (JSON.stringify(old) === JSON.stringify(clean)) return
  await ctx.storage.applyBatch({
    put: { appSettings: [{ key: HOME_KEY, value: clean as unknown as Json }] },
    audit: [auditEntry(ctx, 'setting_changed', { tableName: 'app_settings', recordId: HOME_KEY, oldData: old as unknown as Json, newData: clean as unknown as Json })],
  })
}
