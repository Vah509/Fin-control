import type { Storage } from '../data/storage'
import type { FieldCrypto } from './crypto'

/** Кто действует. Вход и роли вне ядра: слой авторизации передаёт готовое значение.
 *  В локальной версии без входа: { userId: null, isOwner: true }. */
export interface Actor { userId: string | null; isOwner: boolean }

export interface CoreContext {
  storage: Storage
  actor: Actor
  crypto?: FieldCrypto
  now: () => Date
  newId: () => string
}

export function createContext(opts: {
  storage: Storage
  actor?: Actor
  crypto?: FieldCrypto
  now?: () => Date
  newId?: () => string
}): CoreContext {
  return {
    storage: opts.storage,
    actor: opts.actor ?? { userId: null, isOwner: true },
    crypto: opts.crypto,
    now: opts.now ?? (() => new Date()),
    newId: opts.newId ?? (() => crypto.randomUUID()),
  }
}
