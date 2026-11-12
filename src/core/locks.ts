// Закрытие периодов. Запись с датой (в поясе счёта) не позже locked_through менять нельзя.
import type { Account, PeriodLock } from '../data/types'
import type { CoreContext } from './context'
import { fail } from './errors'
import { localDateOf } from './time'
import { readSettings, resolveTimeZone } from './settings'

export const currentLock = (locks: PeriodLock[]): PeriodLock | null =>
  locks.filter((l) => l.status === 'active').sort((a, b) => b.seq - a.seq)[0] ?? null

/** Закрытие общее на все счета: текущая точка = последняя действующая запись. */
export async function getLockedThrough(ctx: CoreContext): Promise<string | null> {
  return currentLock(await ctx.storage.listPeriodLocks())?.lockedThrough ?? null
}

export async function accountTimeZone(ctx: CoreContext, account: Account): Promise<string> {
  const [countries, settings] = await Promise.all([ctx.storage.list('countries'), ctx.storage.list('appSettings')])
  return resolveTimeZone(account, countries, readSettings(settings))
}

/** Бросает PERIOD_LOCKED, если момент (в поясе счёта) попадает в закрытый период. */
export async function assertUnlocked(ctx: CoreContext, account: Account, instantIso: string): Promise<void> {
  const through = await getLockedThrough(ctx)
  if (!through) return
  const tz = await accountTimeZone(ctx, account)
  const day = localDateOf(Date.parse(instantIso), tz)
  if (day <= through) fail('PERIOD_LOCKED', `период закрыт по ${through}, запись от ${day}`, { lockedThrough: through, day })
}

