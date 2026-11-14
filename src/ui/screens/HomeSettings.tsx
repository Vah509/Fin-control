import { useState } from 'react'
import {
  isDivider, newDividerId, orderProjects, projectItems, saveHomeSettings, type HomeBlock, type HomeSettings,
} from '../../core'
import type { Account, Project } from '../../data/types'
import { useApp } from '../app'
import { errorText } from '../format'
import { AccountChip, BackButton, ErrorBox, Screen } from '../parts'
import { useDragSort } from '../dragSort'

const BLOCK_LABEL: Record<HomeBlock, string> = { rates: 'Курсы', accounts: 'Счета', total: 'Общий итог' }

/** Порядок счетов и разделителей одного раздела на Главной (всегда в режиме перетаскивания). */
function SectionList({ project, accounts, h, save }: {
  project: Project; accounts: Account[]; h: HomeSettings
  save: (next: HomeSettings) => Promise<void>
}) {
  const items = projectItems(h.layout, project.id, accounts)
  const drag = useDragSort(items, true, (next) => save({ ...h, layout: { ...h.layout, [project.id]: next } }))
  const byId = new Map(accounts.map((a) => [a.id, a]))
  return (
    <ul className="plain rows">
      {drag.order.map((id, i) => {
        if (isDivider(id)) {
          return (
            <li key={id} ref={drag.setEl(id)} className={`row divider-row${drag.dragging === id ? ' dragging' : ''}`} style={drag.itemStyle(id, i)}>
              <div className="grow muted">— разделитель —</div>
              <button className="btn small" aria-label="Удалить разделитель" onClick={() => void save({ ...h, layout: { ...h.layout, [project.id]: items.filter((x) => x !== id) } })}>✕</button>
              <span className="drag-handle" aria-label="Перетащить разделитель" role="button" {...drag.handleProps(id)}>⠿</span>
            </li>
          )
        }
        const a = byId.get(id)!
        return (
          <li key={id} ref={drag.setEl(id)} className={`row${drag.dragging === id ? ' dragging' : ''}`} style={drag.itemStyle(id, i)}>
            <AccountChip account={a} />
            <div className="row-main grow"><span className="row-title">{a.name}</span></div>
            <span className="drag-handle" aria-label="Перетащить" role="button" {...drag.handleProps(id)}>⠿</span>
          </li>
        )
      })}
    </ul>
  )
}

export function HomeSettingsScreen() {
  const { ctx, ref, bump, reloadRef } = useApp()
  const [error, setError] = useState<string | null>(null)
  const h = ref.home
  const owner = ctx.actor.isOwner

  async function save(next: HomeSettings) {
    setError(null)
    try { await saveHomeSettings(ctx, next); await reloadRef(); bump() } catch (e) { setError(errorText(e)) }
  }
  const flagOf: Record<HomeBlock, keyof HomeSettings> = { rates: 'showRates', accounts: 'showAccounts', total: 'showTotal' }
  const blocks = useDragSort(h.order, owner, (next) => save({ ...h, order: next as HomeBlock[] }))
  const projects = orderProjects(h.projectOrder, ref.projects)
  const pdrag = useDragSort(projects.map((p) => p.id), owner, (next) => save({ ...h, projectOrder: next }))
  const active = ref.accounts.filter((a) => !a.archivedAt)
  const toggleAccount = (id: string) => save({
    ...h, hiddenAccounts: h.hiddenAccounts.includes(id) ? h.hiddenAccounts.filter((x) => x !== id) : [...h.hiddenAccounts, id],
  })
  const shown = (pid: string) => active.filter((a) => a.projectId === pid && !h.hiddenAccounts.includes(a.id))
  const byId = new Map(projects.map((p) => [p.id, p]))

  return (
    <Screen title="Настройки главного экрана" back={<BackButton to="settings" />}>
      {error && <ErrorBox text={error} />}
      {!owner && <p className="muted pad">Менять может только владелец.</p>}

      <div className="card">
        <div className="label">Блоки: что показывать и в каком порядке</div>
        <ul className="plain rows">
          {blocks.order.map((b, i) => (
            <li key={b} ref={blocks.setEl(b)} className={`row${blocks.dragging === b ? ' dragging' : ''}`} style={blocks.itemStyle(b, i)}>
              <label className="check grow">
                <input type="checkbox" checked={h[flagOf[b as HomeBlock]] as boolean} disabled={!owner}
                  onChange={() => void save({ ...h, [flagOf[b as HomeBlock]]: !h[flagOf[b as HomeBlock]] })} />
                {BLOCK_LABEL[b as HomeBlock]}
              </label>
              {owner && <span className="drag-handle" aria-label="Перетащить" role="button" {...blocks.handleProps(b)}>⠿</span>}
            </li>
          ))}
        </ul>
      </div>

      <div className="card form">
        <div className="label">Блок «Счета»: какие счета показывать</div>
        <p className="muted">Снятые счета не показываются на Главной и не входят в её итоги.</p>
        {ref.projects.map((p) => {
          const accs = active.filter((a) => a.projectId === p.id)
          if (accs.length === 0) return null
          return (
            <div key={p.id}>
              <div className="muted">{p.name}</div>
              {accs.map((a) => (
                <label key={a.id} className="check">
                  <input type="checkbox" checked={!h.hiddenAccounts.includes(a.id)} disabled={!owner} onChange={() => void toggleAccount(a.id)} />{a.name}
                </label>
              ))}
            </div>
          )
        })}
      </div>

      <div className="card form">
        <div className="label">Блок «Счета»: оформление</div>
        <label className="check"><input type="checkbox" checked={h.showSectionTotals} disabled={!owner} onChange={() => void save({ ...h, showSectionTotals: !h.showSectionTotals })} />Сумма раздела справа от названия</label>
        <label className="check"><input type="checkbox" checked={h.showDividers} disabled={!owner} onChange={() => void save({ ...h, showDividers: !h.showDividers })} />Разделители между счетами</label>
      </div>

      {owner && (
        <div className="card">
          <div className="label">Блок «Счета»: порядок и разделители</div>
          <p className="muted">Свой порядок Главной, не связан с экраном «Счета». Перетаскивайте за ⠿ разделы, счета и разделители; кнопка ― добавляет разделитель вверху раздела, ✕ удаляет.</p>
          {pdrag.order.map((pid, pi) => {
            const p = byId.get(pid)!
            const accs = shown(pid)
            if (accs.length === 0) return null
            return (
              <div key={pid} ref={pdrag.setEl(pid)} className={`group${pdrag.dragging === pid ? ' dragging' : ''}`} style={pdrag.itemStyle(pid, pi)}>
                <div className="group-head">
                  <h2>{p.name}</h2>
                  <span className="ctl">
                    <button className="btn small" aria-label="Добавить разделитель"
                      onClick={() => void save({ ...h, layout: { ...h.layout, [pid]: [newDividerId(ctx), ...projectItems(h.layout, pid, accs)] } })}>―</button>
                    <span className="drag-handle" aria-label="Перетащить раздел" role="button" {...pdrag.handleProps(pid)}>⠿</span>
                  </span>
                </div>
                <SectionList project={p} accounts={accs} h={h} save={save} />
              </div>
            )
          })}
        </div>
      )}
    </Screen>
  )
}
