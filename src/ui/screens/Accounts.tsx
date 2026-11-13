import { useState } from 'react'
import { createProject, getSnapshot, reorderAccounts, reorderProjects, setAccountArchived, updateProject, type SnapshotRow } from '../../core'
import type { Account, Project } from '../../data/types'
import { useApp } from '../app'
import { useLoad } from '../hooks'
import { errorText, todayLocal } from '../format'
import { AccountChip, AccountRow, ErrorBox, Loading, Screen } from '../parts'
import { useDragSort } from '../dragSort'

/** Список счетов одного раздела; в режиме порядка элементы перетаскиваются за ручку ⠿. */
function AccountList({ project, accounts, edit, base, rowOf, act }: {
  project: Project
  accounts: Account[]
  edit: boolean
  base: string
  rowOf: (id: string) => SnapshotRow | undefined
  act: (fn: () => Promise<unknown>) => Promise<void>
}) {
  const { ctx, go } = useApp()
  const drag = useDragSort(accounts.map((a) => a.id), edit, (next) => act(() => reorderAccounts(ctx, project.id, next)))
  const byId = new Map(accounts.map((a) => [a.id, a]))
  return (
    <ul className="plain rows">
      {drag.order.map((id, i) => {
        const a = byId.get(id)!
        const row = rowOf(a.id)
        return edit ? (
          <li key={a.id} ref={drag.setEl(a.id)} className={`row${drag.dragging === a.id ? ' dragging' : ''}`} style={drag.itemStyle(a.id, i)}>
            <AccountChip account={a} />
            <div className="row-main grow"><span className="row-title">{a.name}</span></div>
            <span className="drag-handle" aria-label="Перетащить" role="button" {...drag.handleProps(a.id)}>⠿</span>
          </li>
        ) : row ? (
          <AccountRow key={a.id} row={row} baseCurrency={base} onClick={() => go('account', { accountId: a.id })} />
        ) : (
          <li key={a.id} className="row tap" onClick={() => go('account', { accountId: a.id })}>
            <AccountChip account={a} /><div className="row-main grow"><span className="row-title">{a.name}</span></div>
          </li>
        )
      })}
    </ul>
  )
}
export function AccountsScreen() {
  const { ctx, ref, go, bump, reloadRef } = useApp()
  const today = todayLocal()
  const q = useLoad(() => getSnapshot(ctx, { date: today }), [today])
  const [edit, setEdit] = useState(false)
  const [adding, setAdding] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const [newName, setNewName] = useState('')
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null)
  const [archiveOpen, setArchiveOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const base = q.data?.totals.baseCurrency ?? ''
  const rowOf = (id: string) => q.data?.rows.find((r) => r.accountId === id)

  async function act(fn: () => Promise<unknown>) {
    setError(null)
    try { await fn(); await reloadRef(); bump() } catch (e) { setError(errorText(e)) }
  }
  const pdrag = useDragSort(ref.projects.map((p) => p.id), edit, (next) => act(() => reorderProjects(ctx, next)))
  const projectById = new Map(ref.projects.map((p) => [p.id, p]))
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
      {q.data && pdrag.order.map((pid, pi) => {
        const p = projectById.get(pid)!
        const accs = ref.accounts.filter((a) => a.projectId === p.id && !a.archivedAt)
        if (accs.length === 0 && !edit) return null
        return (
          <div key={p.id} ref={pdrag.setEl(p.id)} className={`group${pdrag.dragging === p.id ? ' dragging' : ''}`} style={pdrag.itemStyle(p.id, pi)}>
            <div className="group-head">
              {renaming?.id === p.id ? (
                <form className="inline-rename" onSubmit={(e) => {
                  e.preventDefault()
                  void act(async () => { await updateProject(ctx, p.id, { name: renaming.name }); setRenaming(null) })
                }}>
                  <input value={renaming.name} onChange={(e) => setRenaming({ id: p.id, name: e.target.value })} maxLength={60} autoFocus />
                  <button className="btn small primary" disabled={!renaming.name.trim()}>OK</button>
                  <button type="button" className="btn small" onClick={() => setRenaming(null)}>Отмена</button>
                </form>
              ) : <h2>{p.name}</h2>}
              {edit && renaming?.id !== p.id && (
                <span className="ctl">
                  <button className="btn small" aria-label="Переименовать раздел" onClick={() => setRenaming({ id: p.id, name: p.name })}>✎</button>
                  <span className="drag-handle" aria-label="Перетащить раздел" role="button" {...pdrag.handleProps(p.id)}>⠿</span>
                </span>
              )}
            </div>
            {accs.length === 0 && <p className="muted pad">В разделе нет счетов.</p>}
            {accs.length > 0 && <AccountList project={p} accounts={accs} edit={edit} base={base} rowOf={rowOf} act={act} />}
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
      {edit && <p className="muted pad">Удерживайте ⠿ и перетащите счёт или раздел на нужное место. Чтобы перенести счёт в другой раздел, откройте его карточку.</p>}
      <div className="fab-space" aria-hidden="true" />
      {edit ? (
        <button className="fab fab-done" onClick={() => setEdit(false)}>Готово</button>
      ) : (
        <>
          {menuOpen && <div className="fab-backdrop" onClick={() => setMenuOpen(false)} />}
          {menuOpen && (
            <ul className="plain fab-menu" role="menu">
              <li><button role="menuitem" onClick={() => { setMenuOpen(false); go('newAccount') }}>Новый счёт</button></li>
              <li><button role="menuitem" onClick={() => { setMenuOpen(false); setAdding(true); window.scrollTo(0, 0) }}>Новый раздел</button></li>
              <li><button role="menuitem" onClick={() => { setMenuOpen(false); setEdit(true) }}>Изменить порядок</button></li>
            </ul>
          )}
          <button className="fab" aria-label="Меню" aria-haspopup="menu" aria-expanded={menuOpen} onClick={() => setMenuOpen((v) => !v)}>{menuOpen ? '✕' : '☰'}</button>
        </>
      )}
    </Screen>
  )
}
