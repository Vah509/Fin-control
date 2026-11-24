import { useState } from 'react'
import { createTag, createTagGroup, renameTagGroup, reorderTagGroups, reorderTags, setTagArchived, tagTree, updateTag } from '../../core'
import type { Tag, TagGroup } from '../../data/types'
import { useApp } from '../app'
import { useDragSort } from '../dragSort'
import { errorText } from '../format'
import { useLoad } from '../hooks'
import { BackButton, ErrorBox, Loading, Screen } from '../parts'

type Act = (fn: () => Promise<unknown>) => Promise<boolean>
interface Data { groups: TagGroup[]; tags: Tag[]; used: Map<string, number> }

function NameForm({ initial, label, groups, groupId, onSave, onCancel }: {
  initial: string; label: string; groups?: TagGroup[]; groupId?: string
  onSave: (name: string, groupId?: string) => void; onCancel: () => void
}) {
  const [name, setName] = useState(initial)
  const [gid, setGid] = useState(groupId)
  return (
    <form className="tag-form" onSubmit={(e) => { e.preventDefault(); onSave(name, gid) }}>
      <div className="label">{label}</div>
      <input value={name} maxLength={60} autoFocus onChange={(e) => setName(e.target.value)} />
      {groups && <select value={gid} onChange={(e) => setGid(e.target.value)}>{groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}</select>}
      <div className="seg">
        <button className="btn primary" disabled={!name.trim()}>Сохранить</button>
        <button type="button" className="btn" onClick={onCancel}>Отмена</button>
      </div>
    </form>
  )
}

/** Теги одной группы: «ступенька» под заголовком, перетаскивание за ⠿. */
function TagList({ group, tags, data, owner, showArchived, act }: {
  group: TagGroup; tags: Tag[]; data: Data; owner: boolean; showArchived: boolean; act: Act
}) {
  const { ctx } = useApp()
  const [editId, setEditId] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  const visible = tags.filter((t) => showArchived || !t.archivedAt)
  const drag = useDragSort(visible.map((t) => t.id), owner && !editId, (next) => act(() => reorderTags(ctx, group.id, next)))
  const byId = new Map(tags.map((t) => [t.id, t]))
  return (
    <div className="tag-steps">
      <ul className="plain rows">
        {drag.order.map((id, i) => {
          const t = byId.get(id)!
          if (editId === id) {
            return (
              <li key={id} className="row"><NameForm label="Тег" initial={t.name} groups={data.groups} groupId={t.groupId}
                onCancel={() => setEditId(null)}
                onSave={(name, gid) => void act(() => updateTag(ctx, id, { name, groupId: gid })).then((ok) => ok && setEditId(null))} /></li>
            )
          }
          return (
            <li key={id} ref={drag.setEl(id)} className={`row${drag.dragging === id ? ' dragging' : ''}`} style={drag.itemStyle(id, i)}>
              {owner && <span className="drag-handle" aria-label="Перетащить" role="button" {...drag.handleProps(id)}>⠿</span>}
              <div className="row-main grow">
                <span className={t.archivedAt ? 'row-title muted' : 'row-title'}>{t.name}</span>
                <span className="row-sub">{t.archivedAt ? 'в архиве · ' : ''}контрагентов: {data.used.get(t.id) ?? 0}</span>
              </div>
              {owner && (
                <>
                  <button className="btn small" aria-label="Изменить тег" onClick={() => setEditId(id)}>✎</button>
                  <button className="btn small" aria-label={t.archivedAt ? 'Вернуть из архива' : 'В архив'} onClick={() => void act(() => setTagArchived(ctx, id, !t.archivedAt))}>{t.archivedAt ? '↩' : '🗄'}</button>
                </>
              )}
            </li>
          )
        })}
      </ul>
      {owner && (adding
        ? <NameForm label="Новый тег" initial="" onCancel={() => setAdding(false)}
            onSave={(name) => void act(() => createTag(ctx, { groupId: group.id, name })).then((ok) => ok && setAdding(false))} />
        : <button className="btn small" onClick={() => setAdding(true)}>+ Тег</button>)}
    </div>
  )
}

export function TagsScreen() {
  const { ctx, bump } = useApp()
  const data = useLoad(async () => {
    const [groups, tags, cps] = await Promise.all([ctx.storage.list('tagGroups'), ctx.storage.list('tags'), ctx.storage.list('counterparties')])
    const used = new Map<string, number>()
    for (const c of cps) if (c.defaultTagId) used.set(c.defaultTagId, (used.get(c.defaultTagId) ?? 0) + 1)
    return { groups, tags, used } as Data
  }, [])
  const [error, setError] = useState<string | null>(null)
  const [showArchived, setShowArchived] = useState(false)
  const [editGroup, setEditGroup] = useState<string | null>(null)
  const [addingGroup, setAddingGroup] = useState(false)
  const owner = ctx.actor.isOwner
  const tree = data.data ? tagTree(data.data.groups, data.data.tags) : []
  const regular = tree.filter((x) => !x.group.isService)
  const service = tree.filter((x) => x.group.isService)

  const act: Act = async (fn) => {
    setError(null)
    try { await fn(); bump(); return true } catch (e) { setError(errorText(e)); return false }
  }
  const drag = useDragSort(regular.map((x) => x.group.id), owner && !editGroup, (next) => act(() => reorderTagGroups(ctx, next)))
  const byId = new Map(regular.map((x) => [x.group.id, x]))

  const block = (x: { group: TagGroup; tags: Tag[] }, handle: React.ReactNode) => (
    <>
      <div className="group-head">
        {handle}
        {editGroup === x.group.id
          ? <NameForm label="Название группы" initial={x.group.name} onCancel={() => setEditGroup(null)}
              onSave={(name) => void act(() => renameTagGroup(ctx, x.group.id, name)).then((ok) => ok && setEditGroup(null))} />
          : (
            <>
              <h2>{x.group.name}{x.group.isService && <span className="row-sub"> служебная</span>}</h2>
              {owner && !x.group.isService && (
                <span className="ctl"><button className="btn small" aria-label="Переименовать группу" onClick={() => setEditGroup(x.group.id)}>✎</button></span>
              )}
            </>
          )}
      </div>
      {data.data && <TagList group={x.group} tags={x.tags} data={data.data} owner={owner} showArchived={showArchived} act={act} />}
    </>
  )

  return (
    <Screen title="Теги" back={<BackButton to="more" />}>
      {error && <ErrorBox text={error} />}
      {data.loading && !data.data && <Loading />}
      {data.error && <ErrorBox text={data.error} onRetry={data.reload} />}
      {data.data && (
        <>
          <p className="muted">Перетаскивайте за ⠿ группы и теги внутри группы. Перенос тега в другую группу: ✎. Удалять нельзя, только в архив.{!owner && ' Менять может только владелец.'}</p>
          {drag.order.map((id, i) => (
            <div key={id} ref={drag.setEl(id)} className={`group${drag.dragging === id ? ' dragging' : ''}`} style={drag.itemStyle(id, i)}>
              {block(byId.get(id)!, owner ? <span className="drag-handle" aria-label="Перетащить группу" role="button" {...drag.handleProps(id)}>⠿</span> : null)}
            </div>
          ))}
          {service.map((x) => <div key={x.group.id} className="group">{block(x, null)}</div>)}
          {owner && (addingGroup
            ? <div className="card"><NameForm label="Новая группа" initial="" onCancel={() => setAddingGroup(false)}
                onSave={(name) => void act(() => createTagGroup(ctx, { name })).then((ok) => ok && setAddingGroup(false))} /></div>
            : <button className="btn" onClick={() => setAddingGroup(true)}>+ Группа</button>)}
          <label className="row"><input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} /> Показывать архивные теги</label>
        </>
      )}
    </Screen>
  )
}
