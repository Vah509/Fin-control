import { Fragment, useState } from 'react'
import {
  createProject, getSnapshot, groupTotalsByDividers, isDivider, sectionTotals, projectItems, setAccountArchived,
  visibleItems, type SnapshotRow,
} from '../../core'
import type { Account, Project } from '../../data/types'
import { useApp } from '../app'
import { useLoad } from '../hooks'
import { errorText, todayLocal } from '../format'
import { AccountChip, AccountRow, ErrorBox, Loading, Screen, useCurrencyFormat } from '../parts'

/** Список счетов одного раздела (только просмотр; порядок и разделители меняются в «Настройки страницы «Счета»»). */
function AccountList({ project, accounts, base, rows, rowOf }: {
  project: Project
  accounts: Account[]
  base: string
  rows: SnapshotRow[]
  rowOf: (id: string) => SnapshotRow | undefined
}) {
  const { ref, go } = useApp()
  const { fmt } = useCurrencyFormat()
  const shown = visibleItems(projectItems(ref.layout, project.id, accounts))
  const groups = ref.accountsView.showGroupTotals ? groupTotalsByDividers(shown, rows, base) : []
  const headOf = new Map(groups.map((g) => [g.ids[0]!, g]))
  const withHeads = groups.length > 1
  const byId = new Map(accounts.map((a) => [a.id, a]))
  return (
    <ul className="plain rows">
      {shown.map((id, i) => {
        if (isDivider(id)) return withHeads ? null : <li key={id} className="divider" aria-hidden="true" />
        const a = byId.get(id)!
        const row = rowOf(a.id)
        if (!row) {
          return (
            <li key={a.id} className="row tap" onClick={() => go('account', { accountId: a.id })}>
              <AccountChip account={a} /><div className="row-main grow"><span className="row-title">{a.name}</span></div>
            </li>
          )
        }
        const g = withHeads ? headOf.get(a.id) : undefined
        return (
          <Fragment key={a.id}>
            {g && (
              <li className={i === 0 ? 'subhead first' : 'subhead'} aria-hidden="true">
                <span className={g.complete ? '' : 'warn-text'}>{g.complete ? fmt(g.baseMinor, base) : 'нет курса'}</span>
              </li>
            )}
            <AccountRow row={row} baseCurrency={base} onClick={() => go('account', { accountId: a.id })} />
          </Fragment>
        )
      })}
    </ul>
  )
}
export function AccountsScreen() {
  const { ctx, ref, go, bump, reloadRef } = useApp()
  const today = todayLocal()
  const hidden = ref.accountsView.hiddenAccounts
  const includedIds = ref.accounts.filter((a) => !hidden.includes(a.id)).map((a) => a.id)
  const q = useLoad(() => getSnapshot(ctx, { date: today, accountIds: includedIds }), [today, includedIds.join(',')])
  const [adding, setAdding] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const [newName, setNewName] = useState('')
  const [archiveOpen, setArchiveOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const base = q.data?.totals.baseCurrency ?? ''
  const { fmt } = useCurrencyFormat()
  const totals = q.data ? sectionTotals(q.data) : null
  const rowOf = (id: string) => q.data?.rows.find((r) => r.accountId === id)

  async function act(fn: () => Promise<unknown>) {
    setError(null)
    try { await fn(); await reloadRef(); bump() } catch (e) { setError(errorText(e)) }
  }
  const archived = ref.accounts.filter((a) => a.archivedAt)

  return (
    <Screen title="Счета">
      {adding && (
        <form className="card form" onSubmit={(e) => {
          e.preventDefault()
          void act(async () => { await createProject(ctx, { name: newName }); setNewName(''); setAdding(false) })
        }}>
          <label>Название раздела<input value={newName} onChange={(e) => setNewName(e.target.value)} maxLength={60} autoFocus /></label>
          <button className="btn primary" disabled={!newName.trim()}>Добавить раздел</button>
        </form>
      )}
      {error && <ErrorBox text={error} />}
      {q.loading && <Loading />}
      {q.error && <ErrorBox text={q.error} onRetry={q.reload} />}
      {q.data && ref.projects.map((p) => {
        const accs = ref.accounts.filter((a) => a.projectId === p.id && !a.archivedAt && !hidden.includes(a.id))
        if (accs.length === 0) return null
        const t = totals?.get(p.id)
        return (
          <div key={p.id} className="group">
            <div className="group-head">
              <h2>{p.name}</h2>
              {t && <span className={t.complete ? 'group-total' : 'group-total warn-text'}>{t.complete ? fmt(t.baseMinor, base) : 'нет курса'}</span>}
            </div>
            <AccountList project={p} accounts={accs} base={base} rows={q.data!.rows} rowOf={rowOf} />
          </div>
        )
      })}
      {archived.length > 0 && (
        <div className="group">
          <button className="link" onClick={() => setArchiveOpen((v) => !v)}>{archiveOpen ? 'Скрыть архив' : `Архив (${archived.length})`}</button>
          {archiveOpen && (
            <ul className="plain rows">
              {archived.map((a) => (
                <li key={a.id} className="row">
                  <AccountChip account={a} />
                  <div className="row-main grow tap" onClick={() => go('account', { accountId: a.id })}><span className="row-title">{a.name}</span></div>
                  <button className="btn small" onClick={() => void act(() => setAccountArchived(ctx, a.id, false))}>Вернуть</button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      <div className="fab-space" aria-hidden="true" />
      {menuOpen && <div className="fab-backdrop" onClick={() => setMenuOpen(false)} />}
      {menuOpen && (
        <ul className="plain fab-menu" role="menu">
          <li><button role="menuitem" onClick={() => { setMenuOpen(false); go('newAccount') }}>Новый счёт</button></li>
          <li><button role="menuitem" onClick={() => { setMenuOpen(false); setAdding(true); window.scrollTo(0, 0) }}>Новый раздел</button></li>
        </ul>
      )}
      <button className="fab" aria-label="Меню" aria-haspopup="menu" aria-expanded={menuOpen} onClick={() => setMenuOpen((v) => !v)}>{menuOpen ? '✕' : '☰'}</button>
    </Screen>
  )
}
