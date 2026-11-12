import { useState } from 'react'
import { createProject, getSnapshot, reorderAccounts, reorderProjects, setAccountArchived, updateProject } from '../../core'
import type { Account, Project } from '../../data/types'
import { useApp } from '../app'
import { useLoad } from '../hooks'
import { errorText, todayLocal } from '../format'
import { AccountChip, AccountRow, ErrorBox, Loading, Screen } from '../parts'

/** Меняет местами два соседних элемента списка id. */
function swapped(ids: string[], id: string, dir: -1 | 1): string[] | null {
  const i = ids.indexOf(id), j = i + dir
  if (i < 0 || j < 0 || j >= ids.length) return null
  const out = [...ids];[out[i], out[j]] = [out[j]!, out[i]!]
  return out
}

export function AccountsScreen() {
  const { ctx, ref, go, bump, reloadRef } = useApp()
  const today = todayLocal()
  const q = useLoad(() => getSnapshot(ctx, { date: today }), [today])
  const [edit, setEdit] = useState(false)
  const [adding, setAdding] = useState(false)
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
  const moveProject = (p: Project, dir: -1 | 1) => {
    const order = swapped(ref.projects.map((x) => x.id), p.id, dir)
    if (order) void act(() => reorderProjects(ctx, order))
  }
  const moveAcc = (a: Account, dir: -1 | 1) => {
    const order = swapped(ref.accounts.filter((x) => x.projectId === a.projectId).map((x) => x.id), a.id, dir)
    if (order) void act(() => reorderAccounts(ctx, a.projectId, order))
  }
  const archived = ref.accounts.filter((a) => a.archivedAt)

  return (
    <Screen title="Счета">
      <div className="actions">
        <button className="btn small primary" onClick={() => go('newAccount')}>+ Счёт</button>
        <button className="btn small" onClick={() => setAdding((v) => !v)}>+ Раздел</button>
        <button className="btn small" onClick={() => setEdit((v) => !v)}>{edit ? 'Готово' : 'Изменить порядок'}</button>
      </div>
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
      {q.data && ref.projects.map((p, pi) => {
        const accs = ref.accounts.filter((a) => a.projectId === p.id && !a.archivedAt)
        if (accs.length === 0 && !edit) return null
        return (
          <div key={p.id} className="group">
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
                  <button className="btn small" aria-label="Раздел выше" disabled={pi === 0} onClick={() => moveProject(p, -1)}>▲</button>
                  <button className="btn small" aria-label="Раздел ниже" disabled={pi === ref.projects.length - 1} onClick={() => moveProject(p, 1)}>▼</button>
                </span>
              )}
            </div>
            {accs.length === 0 && <p className="muted pad">В разделе нет счетов.</p>}
            <ul className="plain rows">
              {accs.map((a, ai) => {
                const row = rowOf(a.id)
                return edit ? (
                  <li key={a.id} className="row">
                    <AccountChip account={a} />
                    <div className="row-main grow"><span className="row-title">{a.name}</span></div>
                    <span className="ctl">
                      <button className="btn small" aria-label="Выше" disabled={ai === 0} onClick={() => moveAcc(a, -1)}>▲</button>
                      <button className="btn small" aria-label="Ниже" disabled={ai === accs.length - 1} onClick={() => moveAcc(a, 1)}>▼</button>
                    </span>
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
      {!edit && <p className="muted pad">Нажмите на счёт, чтобы переименовать его, сменить иконку и цвет или ввести остаток.</p>}
    </Screen>
  )
}
