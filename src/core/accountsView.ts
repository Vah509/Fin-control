// Настройка страницы «Счета» (ключ `accounts_view`, входит в выгрузку JSON): какие счета показывать и суммы групп.
// Скрытый счёт существует, принимает движения и входит в срезы «Аналитики»; он только не выводится на странице «Счета»
// и не входит в суммы этой страницы (как на Главной).
import type { AppSetting, Json } from '../data/types'
import { auditEntry } from './audit'
import type { CoreContext } from './context'
import { fail } from './errors'

export const ACCOUNTS_VIEW_KEY = 'accounts_view'

export interface AccountsView {
  /** id счетов, скрытых со страницы «Счета» (новые счета показываются сами). */
  hiddenAccounts: string[]
  /** Сумма группы (счета между разделителями) в строке над группой. */
  showGroupTotals: boolean
}

export const freshAccountsView = (): AccountsView => ({ hiddenAccounts: [], showGroupTotals: true })

const strings = (v: unknown): string[] => (Array.isArray(v) ? [...new Set(v.filter((x): x is string => typeof x === 'string'))] : [])

/** Читает настройку; всё непонятное заменяется значениями по умолчанию. */
export function readAccountsView(rows: AppSetting[]): AccountsView {
  const v = rows.find((r) => r.key === ACCOUNTS_VIEW_KEY)?.value
  if (!v || typeof v !== 'object' || Array.isArray(v)) return freshAccountsView()
  const o = v as Record<string, unknown>
  return { hiddenAccounts: strings(o['hiddenAccounts']), showGroupTotals: typeof o['showGroupTotals'] === 'boolean' ? (o['showGroupTotals'] as boolean) : true }
}

/** Сохраняет настройку страницы «Счета». Только владелец. */
export async function saveAccountsView(ctx: CoreContext, next: AccountsView): Promise<void> {
  if (!ctx.actor.isOwner) fail('FORBIDDEN', 'менять настройки может только владелец')
  const clean: AccountsView = { hiddenAccounts: strings(next.hiddenAccounts), showGroupTotals: !!next.showGroupTotals }
  const old = readAccountsView(await ctx.storage.list('appSettings'))
  if (JSON.stringify(old) === JSON.stringify(clean)) return
  await ctx.storage.applyBatch({
    put: { appSettings: [{ key: ACCOUNTS_VIEW_KEY, value: clean as unknown as Json }] },
    audit: [auditEntry(ctx, 'setting_changed', { tableName: 'app_settings', recordId: ACCOUNTS_VIEW_KEY, oldData: old as unknown as Json, newData: clean as unknown as Json })],
  })
}
