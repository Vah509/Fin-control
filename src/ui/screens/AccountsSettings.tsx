import { useState } from 'react'
import {
  isDivider, newDividerId, projectItems, reorderProjects, saveAccountsView, saveProjectLayout, updateProject, type AccountsView,
} from '../../core'
import type { Account, Project } from '../../data/types'
import { useApp } from '../app'
import { errorText } from '../format'
import { AccountChip, BackButton, ErrorBox, Screen } from '../parts'
import { useDragSort } from '../dragSort'

/** Порядок счетов и разделителей одного раздела страницы «Счета» (перетаскивание за ⠿). */
function SectionList({ project, accounts, hidden, act }: {
  project: Project; accounts: Account[]; hidden: string[]
  act: (fn: () => Promise<unknown>) => Promise<void>
}) {
  const { ctx, ref } = useApp()
  const items = projectItems(ref.layout, project.id, accounts)
  const drag = useDragSort(items, true, (next) => act(() => saveProjectLayout(ctx, project.id, next)))
  const byId = new Map(accounts.map((a) => [a.id, a]))
  return (
    <ul className="plain rows">
      {drag.order.map((id, i) => {
        if (isDivider(id)) {
          return (
            <li key={id} ref={drag.setEl(id)} className={`row divider-row${drag.dragging === id ? ' dragging' : ''}`} style={drag.itemStyle(id, i)}>
              <span className="drag-handle" aria-label="Перетащить разделитель" role="button" {...drag.handleProps(id)}>⠿</span>
              <div className="grow muted">— разделитель —</div>
              <button className="btn small" aria-label="Удалить разделитель" onClick={() => void act(() => saveProjectLayout(ctx, project.id, items.filter((x) => x !== id)))}>✕</button>
            </li>
          )
        }
        const a = byId.get(id)!
        return (
          <li key={id} ref={drag.setEl(id)} className={`row${drag.dragging === id ? ' dragging' : ''}`} style={drag.itemStyle(id, i)}>
            <span className="drag-handle" aria-label="Перетащить" role="button" {...drag.handleProps(id)}>⠿</span>
            <AccountChip account={a} />
            <div className="row-main grow">
              <span className="row-title">{a.name}</span>
              {hidden.includes(id) && <span className="row-sub">скрыт со страницы</span>}
            </div>
          </li>
        )
      })}
    </ul>
  )
}

export function AccountsSettingsScreen() {
  const { ctx, ref, bump, reloadRef } = useApp()
  const [error, setError] = useState<string | null>(null)
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null)
  const v = ref.accountsView
  const owner = ctx.actor.isOwner
  async function act(fn: () => Promise<unknown>) {
    setError(null)
    try { await fn(); await reloadRef(); bump() } catch (e) { setError(errorText(e)) }
  }
  const save = (next: AccountsView) => act(() => saveAccountsView(ctx, next))
  const toggle = (id: string) => save({ ...v, hiddenAccounts: v.hiddenAccounts.includes(id) ? v.hiddenAccounts.filter((x) => x !== id) : [...v.hiddenAccounts, id] })
  const active = ref.accounts.filter((a) => !a.archivedAt)
  const pdrag = useDragSort(ref.projects.map((p) => p.id), owner, (next) => act(() => reorderProjects(ctx, next)))
  const byId = new Map(ref.projects.map((p) => [p.id, p]))
  return (
    <Screen title="Настройки страницы «Счета»" back={<BackButton to="settings" />}>
      {error && <ErrorBox text={error} />}
      {!owner && <p className="muted pad">Менять может только владелец.</p>}
      <div className="card form">
        <div className="label">Какие счета показывать</div>
        <p className="muted">Снятый счёт не показывается на странице «Счета» и не входит в её суммы. Сам счёт и загрузка движений по нему не меняются.</p>
        {ref.projects.map((p) => {
          const accs = active.filter((a) => a.projectId === p.id)
          if (accs.length === 0) return null
          return (
            <div key={p.id}>
              <div className="muted">{p.name}</div>
              {accs.map((a) => (
                <label key={a.id} className="check">
                  <input type="checkbox" checked={!v.hiddenAccounts.includes(a.id)} disabled={!owner} onChange={() => void toggle(a.id)} />{a.name}
                </label>
              ))}
            </div>
          )
        })}
      </div>
      <div className="card form">
        <div className="label">Оформление</div>
        <label className="check"><input type="checkbox" checked={v.showGroupTotals} disabled={!owner} onChange={() => void save({ ...v, showGroupTotals: !v.showGroupTotals })} />Сумма группы счетов между разделителями</label>
      </div>
      {owner && (
        <div className="card">
          <div className="label">Порядок и разделители</div>
          <p className="muted">Перетаскивайте за ⠿ разделы, счета и разделители; кнопка ― добавляет разделитель вверху раздела, ✕ удаляет, ✎ переименовывает раздел. Чтобы перенести счёт в другой раздел, откройте его карточку.</p>
          {pdrag.order.map((pid, pi) => {
            const p = byId.get(pid)!
            const accs = active.filter((a) => a.projectId === pid)
            if (accs.length === 0) return null
            return (
              <div key={pid} ref={pdrag.setEl(pid)} className={`group${pdrag.dragging === pid ? ' dragging' : ''}`} style={pdrag.itemStyle(pid, pi)}>
                <div className="group-head">
                  <span className="drag-handle" aria-label="Перетащить раздел" role="button" {...pdrag.handleProps(pid)}>⠿</span>
                  {renaming?.id === pid ? (
                    <form className="inline-rename" onSubmit={(e) => {
                      e.preventDefault()
                      void act(async () => { await updateProject(ctx, pid, { name: renaming.name }); setRenaming(null) })
                    }}>
                      <input value={renaming.name} onChange={(e) => setRenaming({ id: pid, name: e.target.value })} maxLength={60} autoFocus />
                      <button className="btn small primary" disabled={!renaming.name.trim()}>OK</button>
                      <button type="button" className="btn small" onClick={() => setRenaming(null)}>Отмена</button>
                    </form>
                  ) : <h2>{p.name}</h2>}
                  {renaming?.id !== pid && (
                    <span className="ctl">
                      <button className="btn small" aria-label="Добавить разделитель"
                        onClick={() => void act(() => saveProjectLayout(ctx, pid, [newDividerId(ctx), ...projectItems(ref.layout, pid, accs)]))}>―</button>
                      <button className="btn small" aria-label="Переименовать раздел" onClick={() => setRenaming({ id: pid, name: p.name })}>✎</button>
                    </span>
                  )}
                </div>
                <SectionList project={p} accounts={accs} hidden={v.hiddenAccounts} act={act} />
              </div>
            )
          })}
        </div>
      )}
    </Screen>
  )
}
