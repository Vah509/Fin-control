import { createContext, createWebCrypto, type CoreContext } from '../src/core'
import { MemoryStorage } from '../src/data/memory/memoryStorage'
import type { Account, FxRate } from '../src/data/types'

export const ID = {
  lichnoe: 'p-lichnoe', biznes: 'p-biznes',
  space: 'a-space', cashUah: 'a-cash-uah', parents: 'a-parents-eur', freedom: 'a-freedom', mono: 'a-mono',
}

export function account(over: Partial<Account> & Pick<Account, 'id' | 'key' | 'currencyKey' | 'countryKey'>): Account {
  return {
    name: over.key, type: 'bank', institutionId: null, projectId: ID.lichnoe, holder: 'Вахтанг', timezone: null,
    trackingMode: 'balance_and_movements', servicePercent: null, appearance: {}, sortOrder: 0, archivedAt: null, ...over,
  }
}

export class Clock { t = Date.parse('2026-11-09T10:00:00Z'); now = () => new Date(this.t) }

export async function setup(opts: { withCrypto?: boolean; owner?: boolean } = {}) {
  const storage = new MemoryStorage()
  const clock = new Clock()
  let n = 0
  const crypto = opts.withCrypto
    ? await createWebCrypto({ hmacKey: new Uint8Array(32).fill(7), encKey: new Uint8Array(32).fill(9) })
    : undefined
  const ctx: CoreContext = createContext({
    storage, now: clock.now, newId: () => `id-${++n}`, crypto,
    actor: { userId: 'u1', isOwner: opts.owner ?? true },
  })
  await storage.applyBatch({
    put: {
      appSettings: [{ key: 'base_currency', value: 'eur' }, { key: 'default_timezone', value: 'Europe/Bratislava' }],
      planTypes: [{ key: 'planned', name: 'Плановая', sortOrder: 1 }, { key: 'unplanned', name: 'Внеплановая', sortOrder: 2 }],
      countries: [
        { key: 'sk', name: 'Словакия', timezone: 'Europe/Bratislava' },
        { key: 'ua', name: 'Украина', timezone: 'Europe/Kyiv' },
        { key: 'none', name: 'Без страны', timezone: 'default' },
      ],
      currencies: [
        { key: 'eur', code: 'EUR', name: 'Евро', decimals: 2 },
        { key: 'uah', code: 'UAH', name: 'Гривна', decimals: 2 },
        { key: 'usd', code: 'USD', name: 'Доллар', decimals: 2 },
      ],
      projects: [{ id: ID.lichnoe, key: 'lichnoe', name: 'Личное' }, { id: ID.biznes, key: 'biznes', name: 'Бизнес' }],
      accounts: [
        account({ id: ID.space, key: 'slsp_space', currencyKey: 'eur', countryKey: 'sk', sortOrder: 1 }),
        account({ id: ID.cashUah, key: 'cash_uah', currencyKey: 'uah', countryKey: 'ua', type: 'cash', sortOrder: 2 }),
        account({ id: ID.parents, key: 'parents_eur', currencyKey: 'eur', countryKey: 'ua', type: 'person', trackingMode: 'balance_only', sortOrder: 3 }),
        account({ id: ID.freedom, key: 'freedom_usd', currencyKey: 'usd', countryKey: 'none', type: 'broker', trackingMode: 'balance_only', sortOrder: 4 }),
        account({ id: ID.mono, key: 'mono', currencyKey: 'uah', countryKey: 'ua', projectId: ID.biznes, sortOrder: 5 }),
      ],
    },
  })
  return { storage, ctx, clock }
}

export const rate = (id: string, date: string, base: string, quote: string, r: string, source = 'manual'): FxRate =>
  ({ id, rateDate: date, baseCurrencyKey: base, quoteCurrencyKey: quote, rate: r, source })

export async function code(p: Promise<unknown>): Promise<string> {
  try { await p } catch (e) { return (e as { code?: string }).code ?? `OTHER:${(e as Error).message}` }
  return 'NO_ERROR'
}
