// Автообновление курсов при открытии приложения: сообщение для экрана и защита от частых повторов после неудачи.
import { refreshFxRates, type CoreContext, type FxRefreshResult } from '../core'
import { BANK_SOURCES } from '../net/bankRates'
import type { Currency } from '../data/types'

export interface FxNote { kind: 'ok' | 'warn'; text: string }

const FAIL_KEY = 'fc.fx.lastFail'
export const RETRY_AFTER_MS = 10 * 60 * 1000

/** После неудачи автоматически повторяем не чаще, чем раз в 10 минут (у monobank лимит запросов). */
export function shouldTry(nowMs: number, lastFailMs: number | null): boolean {
  return lastFailMs === null || nowMs - lastFailMs >= RETRY_AFTER_MS
}

function readFail(): number | null {
  try { const v = localStorage.getItem(FAIL_KEY); return v ? Number(v) || null : null } catch { return null }
}
function writeFail(ms: number | null) {
  try { if (ms === null) localStorage.removeItem(FAIL_KEY); else localStorage.setItem(FAIL_KEY, String(ms)) } catch { /* хранилище недоступно */ }
}

export function describeFx(res: FxRefreshResult, cur: Map<string, Currency>): FxNote | null {
  const codes = (keys: string[]) => keys.map((k) => cur.get(k)?.code ?? k).join(', ')
  if (res.status === 'fresh' || res.status === 'skipped') return null
  if (res.status === 'updated') return { kind: 'ok', text: `Курсы на сегодня обновлены (${res.sources.join(', ')}).` }
  if (res.status === 'partial') {
    return { kind: 'warn', text: `Курс получен не для всех валют: нет ${codes(res.missing)}. Для них используется последний известный курс.` }
  }
  const why = res.errors[0] ? ` ${res.errors[0]}.` : ''
  return { kind: 'warn', text: `Курсы на сегодня не получены.${why} Используется последний известный курс.` }
}

/** force = true для кнопки «Повторить»: игнорирует паузу после неудачи. */
export async function runFxRefresh(ctx: CoreContext, date: string, cur: Map<string, Currency>, force: boolean): Promise<{ note: FxNote | null; changed: boolean }> {
  const now = Date.now()
  if (!force && !shouldTry(now, readFail())) return { note: null, changed: false }
  const res = await refreshFxRates(ctx, date, BANK_SOURCES)
  writeFail(res.status === 'failed' || res.status === 'partial' ? now : null)
  return { note: describeFx(res, cur), changed: res.status === 'updated' || res.status === 'partial' }
}
