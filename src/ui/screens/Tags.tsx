import { useState } from 'react'
import { createTag, createTagGroup, moveTag, moveTagGroup, renameTagGroup, setTagArchived, tagTree, updateTag } from '../../core'
import type { Tag, TagGroup } from '../../data/types'
import { useApp } from '../app'
import { errorText } from '../format'
import { useLoad } from '../hooks'
import { BackButton, ErrorBox, Loading, Screen } from '../parts'

type Edit =
  | { kind: 'tag'; tag: Tag; name: string; groupId: string }
  | { kind: 'group'; group: TagGroup; name: string }
  | { kind: 'newTag'; groupId: string; name: string }
  | { kind: 'newGroup'; name: string }

export function TagsScreen() {
  const { ctx, bump } = useApp()
  const data = useLoad(async () => {
    const [groups, tags, cps] = await Promise.all([ctx.storage.list('tagGroups'), ctx.storage.list('tags'), ctx.storage.list('counterparties')])
    const used = new Map<string, number>()
    for (const c of cps) if (c.defaultTagId) used.set(c.defaultTagId, (used.get(c.defaultTagId) ?? 0) + 1)
    return { groups, tags, used }
  }, [])
  const [edit, setEdit] = useState<Edit | null>(null)
  const [showArchived, setShowArchived] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const owner = ctx.actor.isOwner

  async function act(fn: () => Promise<unknown>, close = false) {
    setError(null)
    try { await fn(); if (close) setEdit(null); bump() } catch (e) { setError(errorText(e)) }
  }
  function submit() {
    if (!edit) return
    if (edit.kind === 'newGroup') return act(() => createTagGroup(ctx, { name: edit.name }), true)
    if (edit.kind === 'newTag') return act(() => createTag(ctx, { groupId: edit.groupId, name: edit.name }), true)
    if (edit.kind === 'group') return act(() => renameTagGroup(ctx, edit.group.id, edit.name), true)
    return act(() => updateTag(ctx, edit.tag.id, { name: edit.name, groupId: edit.groupId }), true)
  }

  const form = (
    <form className="card" onSubmit={(e) => { e.preventDefault(); void submit() }}>
      {edit && (
        <>
          <div className="label">{edit.kind === 'newGroup' ? 'Новая группа' : edit.kind === 'newTag' ? 'Новый тег' : edit.kind === 'group' ? 'Название группы' : 'Тег'}</div>
          <input value={edit.name} maxLength={60} autoFocus onChange={(e) => setEdit({ ...edit, name: e.target.value })} />
          {edit.kind === 'tag' && data.data && (
            <select value={edit.groupId} onChange={(e) => setEdit({ ...edit, groupId: e.target.value })}>
              {tagTree(data.data.groups, data.data.tags).map(({ group }) => <option key={group.id} value={group.id}>{group.name}</option>)}
            </select>
          )}
          <div className="seg">
            <button className="btn primary" disabled={!edit.name.trim()}>Сохранить</button>
            <button type="button" className="btn" onClick={() => setEdit(null)}>Отмена</button>
          </div>
        </>
      )}
    </form>
  )

  return (
    <Screen title="Теги" back={<BackButton to="more" />}>
      {error && <ErrorBox text={error} />}
      {data.loading && <Loading />}
      {data.error && <ErrorBox text={data.error} onRetry={data.reload} />}
      {data.data && (
        <>
          {!owner && <p className="muted">Менять теги может только владелец.</p>}
          {edit && form}
          {owner && !edit && <button className="btn" onClick={() => setEdit({ kind: 'newGroup', name: '' })}>+ Группа</button>}
          {tagTree(data.data.groups, data.data.tags).map(({ group, tags }) => (
            <div className="card" key={group.id}>
              <div className="row">
                <div className="row-main grow"><span className="row-title">{group.name}</span>{group.isService && <span className="row-sub">служебная</span>}</div>
                {owner && !group.isService && (
                  <>
                    <button className="btn small" aria-label="Вверх" onClick={() => void act(() => moveTagGroup(ctx, group.id, -1))}>▲</button>
                    <button className="btn small" aria-label="Вниз" onClick={() => void act(() => moveTagGroup(ctx, group.id, 1))}>▼</button>
                    <button className="btn small" aria-label="Переименовать группу" onClick={() => setEdit({ kind: 'group', group, name: group.name })}>✎</button>
                  </>
                )}
              </div>
              <ul className="plain rows">
                {tags.filter((t) => showArchived || !t.archivedAt).map((t) => (
                  <li className="row" key={t.id}>
                    <div className="row-main grow">
                      <span className={t.archivedAt ? 'row-title muted' : 'row-title'}>{t.name}</span>
                      <span className="row-sub">{t.archivedAt ? 'в архиве · ' : ''}контрагентов: {data.data?.used.get(t.id) ?? 0}</span>
                    </div>
                    {owner && (
                      <>
                        <button className="btn small" aria-label="Вверх" onClick={() => void act(() => moveTag(ctx, t.id, -1))}>▲</button>
                        <button className="btn small" aria-label="Вниз" onClick={() => void act(() => moveTag(ctx, t.id, 1))}>▼</button>
                        <button className="btn small" aria-label="Изменить тег" onClick={() => setEdit({ kind: 'tag', tag: t, name: t.name, groupId: t.groupId })}>✎</button>
                        <button className="btn small" aria-label={t.archivedAt ? 'Вернуть из архива' : 'В архив'} onClick={() => void act(() => setTagArchived(ctx, t.id, !t.archivedAt))}>{t.archivedAt ? '↩' : '🗄'}</button>
                      </>
                    )}
                  </li>
                ))}
              </ul>
              {owner && <button className="btn small" onClick={() => setEdit({ kind: 'newTag', groupId: group.id, name: '' })}>+ Тег</button>}
            </div>
          ))}
          <label className="row"><input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} /> Показывать архивные теги</label>
        </>
      )}
    </Screen>
  )
}
