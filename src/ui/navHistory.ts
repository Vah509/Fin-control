// Навигация по истории браузера: кнопка «назад» (Android, жест) возвращает на предыдущий экран.
import type { Page } from './app'

export const PAGES: readonly Page[] = [
  'home', 'snapshot', 'moves', 'accounts', 'more', 'balance', 'periods', 'dump', 'account', 'newAccount',
]

/** Состояние, которое лежит в записи истории браузера. `idx` = номер записи внутри приложения (0 = первая). */
export interface NavState { idx: number; page: Page; accountId?: string }

/** Читает состояние записи истории; всё незнакомое (чужие записи, старые версии) даёт null. */
export function readNavState(s: unknown): NavState | null {
  if (!s || typeof s !== 'object') return null
  const o = s as Record<string, unknown>
  const page = PAGES.find((p) => p === o.page)
  if (!page || typeof o.idx !== 'number' || !Number.isInteger(o.idx) || o.idx < 0) return null
  const accountId = typeof o.accountId === 'string' ? o.accountId : undefined
  return { idx: o.idx, page, accountId }
}

/** Можно ли вернуться назад внутри приложения (иначе «назад» закрыло бы приложение). */
export function canGoBack(s: unknown): boolean {
  return (readNavState(s)?.idx ?? 0) > 0
}
