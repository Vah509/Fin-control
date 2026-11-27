// Точки отсчёта остатка из таблицы balance_periods (docs/ANCHORS.md, docs/STATEMENT-DOCS.md этап 2).
// Остаток на момент = ближайшая более ранняя точка + движения после неё. До первой точки остаток неизвестен (null).
import type { BalancePeriod, Transaction } from '../data/types'
import { endOfLocalDayMs, startOfLocalDayMs } from './time'

/** Точка: на момент atMs (включительно) остаток равен balanceMinor; движения считаются строго после atMs. */
export interface BalancePoint { atMs: number; balanceMinor: number }

/**
 * Действующие периоды счёта → отсортированные точки. Выписка: остаток на начало (за миллисекунду до начала первого дня) и на конец (конец последнего дня).
 * Ручная фиксация: одна точка на конец дня periodEnd. Одинаковые моменты сохраняют порядок создания (последняя запись главнее).
 */
export function periodPoints(periods: BalancePeriod[], accountId: string, tz: string): BalancePoint[] {
  const pts: { atMs: number; balanceMinor: number; created: string }[] = []
  for (const p of periods) {
    if (p.accountId !== accountId || p.status !== 'active') continue
    if (p.source === 'statement') pts.push({ atMs: startOfLocalDayMs(p.periodStart, tz) - 1, balanceMinor: p.openingMinor, created: p.createdAt })
    pts.push({ atMs: endOfLocalDayMs(p.periodEnd, tz), balanceMinor: p.closingMinor, created: p.createdAt })
  }
  pts.sort((a, b) => a.atMs - b.atMs || a.created.localeCompare(b.created))
  return pts.map(({ atMs, balanceMinor }) => ({ atMs, balanceMinor }))
}

const ms = (t: Transaction) => Date.parse(t.bookedAt)

/** Остаток на момент по точкам и движениям счёта; null, если раньше первой точки. */
export function pointBalance(points: BalancePoint[], txs: Transaction[], instantMs: number): number | null {
  let p: BalancePoint | null = null
  for (const x of points) if (x.atMs <= instantMs) p = x
  if (!p) return null
  const from = p.atMs
  return p.balanceMinor + txs.reduce((s, t) => (ms(t) > from && ms(t) <= instantMs ? s + t.amountMinor : s), 0)
}

/** Неучтённая разница в каждой точке: цифра точки минус «предыдущая точка + движения между ними». Первая точка разницы не имеет. */
export function pointGaps(points: BalancePoint[], txs: Transaction[]): { atMs: number; gapMinor: number }[] {
  const out: { atMs: number; gapMinor: number }[] = []
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!, b = points[i]!
    const moved = txs.reduce((s, t) => (ms(t) > a.atMs && ms(t) <= b.atMs ? s + t.amountMinor : s), 0)
    const gap = b.balanceMinor - (a.balanceMinor + moved)
    if (gap !== 0) out.push({ atMs: b.atMs, gapMinor: gap })
  }
  return out
}
