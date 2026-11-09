import type { Account, AppSetting, Country } from '../data/types'
import { fail } from './errors'
import { isValidTimeZone } from './time'

export interface Settings {
  baseCurrency: string | null
  defaultTimezone: string | null
  fxPivotCurrency: string | null
}

export function readSettings(rows: AppSetting[]): Settings {
  const s = (k: string) => {
    const v = rows.find((r) => r.key === k)?.value
    return typeof v === 'string' && v !== '' ? v : null
  }
  return { baseCurrency: s('base_currency'), defaultTimezone: s('default_timezone'), fxPivotCurrency: s('fx_pivot_currency') }
}

/** Порядок: пояс счёта, затем пояс страны; 'default' берёт default_timezone из настроек. */
export function resolveTimeZone(account: Pick<Account, 'timezone' | 'countryKey'>, countries: Country[], settings: Settings): string {
  let tz = account.timezone
  if (!tz) {
    const c = countries.find((x) => x.key === account.countryKey)
    if (!c) return fail('NOT_FOUND', `страна ${account.countryKey} не найдена`)
    tz = c.timezone
  }
  if (tz === 'default') tz = settings.defaultTimezone
  if (!tz || !isValidTimeZone(tz)) return fail('INVALID_TIMEZONE', `не удалось определить пояс (${tz ?? 'пусто'})`)
  return tz
}
