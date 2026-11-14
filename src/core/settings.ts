import type { Account, AppSetting, Country } from '../data/types'
import { auditEntry } from './audit'
import type { CoreContext } from './context'
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

/** Валюты, доступные как базовая для итогов (решение 13.11.2026). */
export const BASE_CURRENCY_CHOICES = ['uah', 'eur', 'usd'] as const

/** Меняет базовую валюту итогов. Только владелец; валюта из списка выбора и из справочника. Прошлые данные не трогает. */
export async function setBaseCurrency(ctx: CoreContext, currencyKey: string): Promise<void> {
  if (!ctx.actor.isOwner) fail('FORBIDDEN', 'менять настройки может только владелец')
  if (!(BASE_CURRENCY_CHOICES as readonly string[]).includes(currencyKey)) fail('INVALID_FIELD', `базовой валютой может быть только ${BASE_CURRENCY_CHOICES.join(', ')}`)
  const [currencies, rows] = await Promise.all([ctx.storage.list('currencies'), ctx.storage.list('appSettings')])
  if (!currencies.some((c) => c.key === currencyKey)) fail('NOT_FOUND', `валюта ${currencyKey} не найдена`)
  const old = readSettings(rows).baseCurrency
  if (old === currencyKey) return
  await ctx.storage.applyBatch({
    put: { appSettings: [{ key: 'base_currency', value: currencyKey }] },
    audit: [auditEntry(ctx, 'setting_changed', { tableName: 'app_settings', recordId: 'base_currency', oldData: old, newData: currencyKey })],
  })
}
