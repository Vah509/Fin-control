// Контекст приложения: ядро с хранилищем Supabase, справочники, навигация. Экраны вызывают только ядро.
import { createContext, useCallback, useContext, useEffect, useRef, useState, type DependencyList } from 'react'
import {
  createContext as createCoreContext, readSettings, type CoreContext, type Settings,
} from '../core'
import type { Account, Country, Currency, Institution, Project } from '../data/types'
import { SupabaseStorage } from '../data/supabase'
import type { FxNote } from './fxAuto'

export interface RefData {
  accounts: Account[]; projects: Project[]; countries: Country[]
  currencies: Currency[]; institutions: Institution[]; settings: Settings
  cur: Map<string, Currency>
}

export async function loadRef(ctx: CoreContext): Promise<RefData> {
  const s = ctx.storage
  const [accounts, projects, countries, currencies, institutions, settingsRows] = await Promise.all([
    s.list('accounts'), s.list('projects'), s.list('countries'), s.list('currencies'),
    s.list('institutions'), s.list('appSettings'),
  ])
  accounts.sort((a, b) => a.sortOrder - b.sortOrder || a.key.localeCompare(b.key))
  projects.sort((a, b) => a.sortOrder - b.sortOrder || a.key.localeCompare(b.key))
  return {
    accounts, projects, countries, currencies, institutions, settings: readSettings(settingsRows),
    cur: new Map(currencies.map((c) => [c.key, c])),
  }
}

export type Page = 'home' | 'snapshot' | 'moves' | 'accounts' | 'more' | 'balance' | 'periods' | 'dump' | 'account' | 'newAccount'
export interface NavOptions { accountId?: string }

export interface AppApi {
  ctx: CoreContext
  ref: RefData
  email: string
  go: (page: Page, opts?: NavOptions) => void
  /** Назад на предыдущий экран; если истории нет, переход на `fallback`. */
  back: (fallback: Page) => void
  signOut: () => Promise<void>
  /** Перечитать справочники (счета, разделы) после правки. */
  reloadRef: () => Promise<void>
  /** Увеличивается после записи, чтобы экраны перечитали данные. */
  version: number
  bump: () => void
  /** Результат автообновления курсов (null = всё в порядке или ещё не проверялось). */
  fx: FxNote | null
  /** Запросить курсы у банка вручную. */
  refreshFx: () => Promise<void>
}

const Ctx = createContext<AppApi | null>(null)
export const AppProvider = Ctx.Provider
export function useApp(): AppApi {
  const v = useContext(Ctx)
  if (!v) throw new Error('useApp вне AppProvider')
  return v
}

export function buildCore(storage: SupabaseStorage, actor: { userId: string | null; isOwner: boolean }): CoreContext {
  return createCoreContext({ storage, actor })   // ключей шифрования номеров пока нет (решение 10 ноября)
}

export interface Async<T> { data: T | null; error: string | null; loading: boolean; reload: () => void }

/** Загрузка данных для экрана. Устаревший ответ отбрасывается, если зависимости успели смениться. */
export function useAsync<T>(fn: () => Promise<T>, deps: DependencyList, toText: (e: unknown) => string): Async<T> {
  const [state, setState] = useState<{ data: T | null; error: string | null; loading: boolean }>({ data: null, error: null, loading: true })
  const [tick, setTick] = useState(0)
  const fnRef = useRef(fn)
  fnRef.current = fn
  useEffect(() => {
    let dead = false
    setState((s) => ({ ...s, loading: true, error: null }))
    fnRef.current().then(
      (data) => { if (!dead) setState({ data, error: null, loading: false }) },
      (e) => { if (!dead) setState({ data: null, error: toText(e), loading: false }) },
    )
    return () => { dead = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick])
  const reload = useCallback(() => setTick((t) => t + 1), [])
  return { ...state, reload }
}
