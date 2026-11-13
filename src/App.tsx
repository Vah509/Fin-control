// Корень приложения: вход, загрузка справочников, нижняя панель вкладок. Экраны вызывают только ядро.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createSupabaseClient, SupabaseStorage } from './data/supabase'
import { currentSession, loadActor, signIn, signOut as authSignOut } from './auth/auth'
import { AppProvider, buildCore, loadRef, type AppApi, type NavOptions, type Page, type RefData } from './ui/app'
import { errorText, todayLocal } from './ui/format'
import { runFxRefresh, type FxNote } from './ui/fxAuto'
import type { CoreContext } from './core'
import { Login } from './ui/screens/Login'
import { Home } from './ui/screens/Home'
import { SnapshotScreen } from './ui/screens/Snapshot'
import { BalanceScreen } from './ui/screens/Balance'
import { MovesScreen } from './ui/screens/Moves'
import { AccountsScreen } from './ui/screens/Accounts'
import { MoreScreen } from './ui/screens/More'
import { PeriodsScreen } from './ui/screens/Periods'
import { DumpScreen } from './ui/screens/Dump'
import { AccountScreen } from './ui/screens/Account'
import { NewAccountScreen } from './ui/screens/NewAccount'
import { ErrorBox, Loading } from './ui/parts'
import { canGoBack, readNavState } from './ui/navHistory'
import type { Session, SupabaseClient } from '@supabase/supabase-js'

const TABS: { page: Page; label: string; icon: string }[] = [
  { page: 'home', label: 'Главная', icon: '⌂' },
  { page: 'accounts', label: 'Счета', icon: '▭' },
  { page: 'moves', label: 'Движения', icon: '⇅' },
  { page: 'snapshot', label: 'Аналитика', icon: '▤' },
  { page: 'more', label: 'Прочее', icon: '⋯' },
]
const TAB_OF: Record<Page, Page> = {
  home: 'home', balance: 'home', snapshot: 'snapshot', moves: 'moves', accounts: 'accounts',
  more: 'more', periods: 'more', dump: 'more', account: 'accounts', newAccount: 'accounts',
}

/** Ярлыки PWA: /?go=snapshot и /?go=balance. */
function startPage(): Page {
  const go = new URLSearchParams(window.location.search).get('go')
  return go === 'snapshot' || go === 'balance' ? go : 'home'
}

type Boot =
  | { phase: 'boot' }
  | { phase: 'fatal'; text: string }
  | { phase: 'login' }
  | { phase: 'ready'; ctx: CoreContext; ref: RefData; email: string }

export function App() {
  const [boot, setBoot] = useState<Boot>({ phase: 'boot' })
  const [db, setDb] = useState<SupabaseClient | null>(null)

  const enter = useCallback(async (client: SupabaseClient, session: Session) => {
    const actor = await loadActor(client, session)
    const ctx = buildCore(new SupabaseStorage(client), actor)
    const ref = await loadRef(ctx)
    setBoot({ phase: 'ready', ctx, ref, email: session.user.email ?? '' })
  }, [])

  useEffect(() => {
    let client: SupabaseClient
    try { client = createSupabaseClient() } catch (e) { setBoot({ phase: 'fatal', text: errorText(e) }); return }
    setDb(client)
    currentSession(client)
      .then((s) => (s ? enter(client, s) : setBoot({ phase: 'login' })))
      .catch((e) => setBoot({ phase: 'fatal', text: errorText(e) }))
    const { data } = client.auth.onAuthStateChange((_event, session) => { if (!session) setBoot({ phase: 'login' }) })
    return () => data.subscription.unsubscribe()
  }, [enter])

  if (boot.phase === 'boot') return <Loading what="Запуск…" />
  if (boot.phase === 'fatal') return <main className="login"><ErrorBox text={boot.text} /></main>
  if (boot.phase === 'login' || !db) {
    return <Login onLogin={async (email, password) => { if (db) await enter(db, await signIn(db, email, password)) }} />
  }
  return <Shell db={db} ctx={boot.ctx} initialRef={boot.ref} email={boot.email} />
}

export function Shell({ db, ctx, initialRef, email }: { db: SupabaseClient; ctx: CoreContext; initialRef: RefData; email: string }) {
  const [page, setPage] = useState<Page>(() => readNavState(window.history.state)?.page ?? startPage())
  const [accountId, setAccountId] = useState<string | undefined>(() => readNavState(window.history.state)?.accountId)
  const [version, setVersion] = useState(0)
  const [ref, setRef] = useState<RefData>(initialRef)
  const [fx, setFx] = useState<FxNote | null>(null)
  const cur = useRef<{ page: Page; accountId?: string }>({ page, accountId })
  cur.current = { page, accountId }

  // История: первая запись это «Главная» (с неё «назад» закрывает приложение); если приложение открыто ярлыком
  // на другой экран, поверх «Главной» добавляется запись этого экрана. После перезагрузки состояние берётся из истории.
  useEffect(() => {
    if (readNavState(window.history.state)) return
    const path = window.location.pathname
    const start = startPage()
    window.history.replaceState({ idx: 0, page: 'home' }, '', path)
    if (start !== 'home') window.history.pushState({ idx: 1, page: start }, '', path)
  }, [])
  useEffect(() => {
    const onPop = (e: PopStateEvent) => {
      const st = readNavState(e.state)
      if (!st) return
      setAccountId(st.accountId); setPage(st.page); window.scrollTo(0, 0)
    }
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [])

  const show = useCallback((p: Page, id: string | undefined, replace: boolean) => {
    const same = cur.current.page === p && cur.current.accountId === id
    if (!same) {
      const idx = (readNavState(window.history.state)?.idx ?? 0) + (replace ? 0 : 1)
      const st = { idx, page: p, accountId: id }
      if (replace) window.history.replaceState(st, '', window.location.pathname)
      else window.history.pushState(st, '', window.location.pathname)
      setAccountId(id); setPage(p)
    }
    window.scrollTo(0, 0)
  }, [])
  const go = useCallback((p: Page, opts?: NavOptions) => show(p, opts?.accountId, false), [show])
  const back = useCallback((fallback: Page) => {
    if (canGoBack(window.history.state)) window.history.back()
    else show(fallback, undefined, true)
  }, [show])
  const refreshFx = useCallback(async (force = true) => {
    try {
      const { note, changed } = await runFxRefresh(ctx, todayLocal(), initialRef.cur, force)
      setFx(note)
      if (changed) setVersion((v) => v + 1)
    } catch (e) {
      setFx({ kind: 'warn', text: `Курсы не обновлены: ${errorText(e)}` })
    }
  }, [ctx, initialRef])
  // Курс на сегодня: при открытии проверяем и при необходимости берём у банка (monobank, затем ПриватБанк).
  useEffect(() => { void refreshFx(false) }, [refreshFx])

  const api: AppApi = useMemo(() => ({
    ctx, ref, email, go, back, version, fx, refreshFx: () => refreshFx(true),
    bump: () => setVersion((v) => v + 1),
    reloadRef: async () => { setRef(await loadRef(ctx)) },
    signOut: () => authSignOut(db),
  }), [ctx, ref, email, go, back, version, db, fx, refreshFx])

  return (
    <AppProvider value={api}>
      <div className="app">
        <main className="content" key={`${page}:${accountId ?? ''}`}>
          {page === 'home' && <Home />}
          {page === 'snapshot' && <SnapshotScreen />}
          {page === 'balance' && <BalanceScreen initialAccountId={accountId} />}
          {page === 'moves' && <MovesScreen />}
          {page === 'accounts' && <AccountsScreen />}
          {page === 'more' && <MoreScreen />}
          {page === 'periods' && <PeriodsScreen />}
          {page === 'dump' && <DumpScreen />}
          {page === 'account' && accountId && <AccountScreen accountId={accountId} />}
          {page === 'newAccount' && <NewAccountScreen />}
        </main>
        <nav className="tabs" aria-label="Разделы">
          {TABS.map((t) => (
            <button key={t.page} className={TAB_OF[page] === t.page ? 'tab active' : 'tab'} onClick={() => go(t.page)}>
              <span aria-hidden="true">{t.icon}</span>{t.label}
            </button>
          ))}
        </nav>
      </div>
    </AppProvider>
  )
}
