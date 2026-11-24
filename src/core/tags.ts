// Справочник тегов: группы и теги (два уровня). Правка только владельцем; удалять нельзя, теги архивируются.
// Служебная группа («Разовые») не переименовывается и не двигается.
import type { Tag, TagGroup } from '../data/types'
import { auditEntry } from './audit'
import type { CoreContext } from './context'
import { fail } from './errors'
import { makeKey } from './keys'

function needOwner(ctx: CoreContext) {
  if (!ctx.actor.isOwner) fail('FORBIDDEN', 'менять теги может только владелец')
}
const byOrder = <T extends { sortOrder: number; key: string }>(xs: T[]) =>
  [...xs].sort((a, b) => a.sortOrder - b.sortOrder || a.key.localeCompare(b.key))
const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase()
function cleanName(s: string, what: string): string {
  const n = s.trim().replace(/\s+/g, ' ')
  if (!n) fail('INVALID_FIELD', `нужно название ${what}`)
  if (n.length > 60) fail('INVALID_FIELD', `название ${what} длиннее 60 знаков`)
  return n
}

/** Группы по порядку (служебная в конце), теги каждой группы по порядку. */
export function tagTree(groups: TagGroup[], tags: Tag[]): { group: TagGroup; tags: Tag[] }[] {
  const gs = [...groups].sort((a, b) => Number(a.isService) - Number(b.isService) || a.sortOrder - b.sortOrder || a.key.localeCompare(b.key))
  return gs.map((group) => ({ group, tags: byOrder(tags.filter((t) => t.groupId === group.id)) }))
}

export async function createTagGroup(ctx: CoreContext, input: { name: string }): Promise<TagGroup> {
  needOwner(ctx)
  const name = cleanName(input.name, 'группы')
  const groups = await ctx.storage.list('tagGroups')
  if (groups.some((g) => same(g.name, name))) fail('DUPLICATE_KEY', `группа «${name}» уже есть`)
  const group: TagGroup = {
    id: ctx.newId(), key: makeKey(name, groups.map((g) => g.key), 'gruppa'), name, isService: false,
    sortOrder: groups.filter((g) => !g.isService).reduce((m, g) => Math.max(m, g.sortOrder), 0) + 1,
  }
  await ctx.storage.applyBatch({
    put: { tagGroups: [group] },
    audit: [auditEntry(ctx, 'tag_group_created', { tableName: 'tag_groups', recordId: group.id, newData: group as never })],
  })
  return group
}

export async function renameTagGroup(ctx: CoreContext, id: string, nameIn: string): Promise<TagGroup> {
  needOwner(ctx)
  const name = cleanName(nameIn, 'группы')
  const groups = await ctx.storage.list('tagGroups')
  const old = groups.find((g) => g.id === id) ?? fail('NOT_FOUND', 'группа не найдена')
  if (old.isService) fail('INVALID_FIELD', 'служебную группу переименовать нельзя')
  if (groups.some((g) => g.id !== id && same(g.name, name))) fail('DUPLICATE_KEY', `группа «${name}» уже есть`)
  if (old.name === name) return old
  const next = { ...old, name }
  await ctx.storage.applyBatch({
    put: { tagGroups: [next] },
    audit: [auditEntry(ctx, 'tag_group_renamed', { tableName: 'tag_groups', recordId: id, oldData: old as never, newData: next as never })],
  })
  return next
}

/** Сдвиг группы на одну позицию вверх (-1) или вниз (1) среди обычных групп. */
export async function moveTagGroup(ctx: CoreContext, id: string, dir: -1 | 1): Promise<void> {
  needOwner(ctx)
  const groups = await ctx.storage.list('tagGroups')
  const g = groups.find((x) => x.id === id) ?? fail('NOT_FOUND', 'группа не найдена')
  if (g.isService) fail('INVALID_FIELD', 'служебную группу двигать нельзя')
  const list = byOrder(groups.filter((x) => !x.isService))
  const i = list.findIndex((x) => x.id === id)
  const j = i + dir
  if (j < 0 || j >= list.length) return
  ;[list[i], list[j]] = [list[j], list[i]]
  const changed = list.map((x, k) => ({ ...x, sortOrder: k + 1 })).filter((x) => x.sortOrder !== groups.find((o) => o.id === x.id)!.sortOrder)
  await ctx.storage.applyBatch({
    put: { tagGroups: changed },
    audit: [auditEntry(ctx, 'tag_groups_reordered', { tableName: 'tag_groups', details: { order: list.map((x) => x.id) } })],
  })
}

export async function createTag(ctx: CoreContext, input: { groupId: string; name: string }): Promise<Tag> {
  needOwner(ctx)
  const name = cleanName(input.name, 'тега')
  const [groups, tags] = await Promise.all([ctx.storage.list('tagGroups'), ctx.storage.list('tags')])
  if (!groups.some((g) => g.id === input.groupId)) fail('NOT_FOUND', 'группа не найдена')
  if (tags.some((t) => t.groupId === input.groupId && same(t.name, name))) fail('DUPLICATE_KEY', `тег «${name}» в этой группе уже есть`)
  const tag: Tag = {
    id: ctx.newId(), key: makeKey(name, tags.map((t) => t.key), 'tag'), groupId: input.groupId, name,
    sortOrder: tags.filter((t) => t.groupId === input.groupId).reduce((m, t) => Math.max(m, t.sortOrder), -1) + 1, archivedAt: null,
  }
  await ctx.storage.applyBatch({
    put: { tags: [tag] },
    audit: [auditEntry(ctx, 'tag_created', { tableName: 'tags', recordId: tag.id, newData: tag as never })],
  })
  return tag
}

/** Переименование и/или перенос в другую группу (в конец). Привязки контрагентов не меняются: они по id. */
export async function updateTag(ctx: CoreContext, id: string, patch: { name?: string; groupId?: string }): Promise<Tag> {
  needOwner(ctx)
  const [groups, tags] = await Promise.all([ctx.storage.list('tagGroups'), ctx.storage.list('tags')])
  const old = tags.find((t) => t.id === id) ?? fail('NOT_FOUND', 'тег не найден')
  const name = patch.name === undefined ? old.name : cleanName(patch.name, 'тега')
  const groupId = patch.groupId ?? old.groupId
  if (!groups.some((g) => g.id === groupId)) fail('NOT_FOUND', 'группа не найдена')
  if (tags.some((t) => t.id !== id && t.groupId === groupId && same(t.name, name))) fail('DUPLICATE_KEY', `тег «${name}» в группе уже есть`)
  if (name === old.name && groupId === old.groupId) return old
  const sortOrder = groupId === old.groupId ? old.sortOrder
    : tags.filter((t) => t.groupId === groupId).reduce((m, t) => Math.max(m, t.sortOrder), -1) + 1
  const next: Tag = { ...old, name, groupId, sortOrder }
  await ctx.storage.applyBatch({
    put: { tags: [next] },
    audit: [auditEntry(ctx, groupId === old.groupId ? 'tag_renamed' : 'tag_moved', { tableName: 'tags', recordId: id, oldData: old as never, newData: next as never })],
  })
  return next
}

/** Архив вместо удаления: тег остаётся у старых контрагентов и операций, но в выборе не предлагается. */
export async function setTagArchived(ctx: CoreContext, id: string, archived: boolean): Promise<Tag> {
  needOwner(ctx)
  const old = (await ctx.storage.list('tags')).find((t) => t.id === id) ?? fail('NOT_FOUND', 'тег не найден')
  if ((old.archivedAt !== null) === archived) return old
  const next: Tag = { ...old, archivedAt: archived ? ctx.now().toISOString() : null }
  await ctx.storage.applyBatch({
    put: { tags: [next] },
    audit: [auditEntry(ctx, archived ? 'tag_archived' : 'tag_restored', { tableName: 'tags', recordId: id })],
  })
  return next
}

/** Сдвиг тега на одну позицию вверх (-1) или вниз (1) внутри группы. */
export async function moveTag(ctx: CoreContext, id: string, dir: -1 | 1): Promise<void> {
  needOwner(ctx)
  const tags = await ctx.storage.list('tags')
  const t = tags.find((x) => x.id === id) ?? fail('NOT_FOUND', 'тег не найден')
  const list = byOrder(tags.filter((x) => x.groupId === t.groupId))
  const i = list.findIndex((x) => x.id === id)
  const j = i + dir
  if (j < 0 || j >= list.length) return
  ;[list[i], list[j]] = [list[j], list[i]]
  const changed = list.map((x, k) => ({ ...x, sortOrder: k })).filter((x) => x.sortOrder !== tags.find((o) => o.id === x.id)!.sortOrder)
  await ctx.storage.applyBatch({
    put: { tags: changed },
    audit: [auditEntry(ctx, 'tags_reordered', { tableName: 'tags', details: { groupId: t.groupId, order: list.map((x) => x.id) } })],
  })
}

/** Подмножество в новом порядке занимает те же места, что и раньше; остальные элементы (например архивные теги) стоят где стояли. */
function applySubsetOrder<T extends { id: string }>(current: T[], orderedIds: string[]): T[] {
  const set = new Set(orderedIds)
  const byId = new Map(current.map((x) => [x.id, x]))
  if (orderedIds.length !== set.size || !orderedIds.every((id) => byId.has(id))) fail('INVALID_FIELD', 'в порядке только существующие элементы по одному разу')
  const queue = [...orderedIds]
  return current.map((x) => (set.has(x.id) ? byId.get(queue.shift()!)! : x))
}

/** Порядок обычных групп перетаскиванием (служебная всегда последняя). */
export async function reorderTagGroups(ctx: CoreContext, orderedIds: string[]): Promise<void> {
  needOwner(ctx)
  const groups = await ctx.storage.list('tagGroups')
  const list = byOrder(groups.filter((g) => !g.isService))
  if (orderedIds.some((id) => !list.some((g) => g.id === id))) fail('INVALID_FIELD', 'служебную группу двигать нельзя')
  const next = applySubsetOrder(list, orderedIds)
  const changed = next.map((g, k) => ({ ...g, sortOrder: k + 1 })).filter((g) => g.sortOrder !== list.find((o) => o.id === g.id)!.sortOrder)
  if (!changed.length) return
  await ctx.storage.applyBatch({
    put: { tagGroups: changed },
    audit: [auditEntry(ctx, 'tag_groups_reordered', { tableName: 'tag_groups', details: { order: next.map((g) => g.id) } })],
  })
}

/** Порядок тегов группы перетаскиванием (можно передать только видимые, архивные остаются на местах). */
export async function reorderTags(ctx: CoreContext, groupId: string, orderedIds: string[]): Promise<void> {
  needOwner(ctx)
  const tags = await ctx.storage.list('tags')
  const list = byOrder(tags.filter((t) => t.groupId === groupId))
  const next = applySubsetOrder(list, orderedIds)
  const changed = next.map((t, k) => ({ ...t, sortOrder: k })).filter((t) => t.sortOrder !== list.find((o) => o.id === t.id)!.sortOrder)
  if (!changed.length) return
  await ctx.storage.applyBatch({
    put: { tags: changed },
    audit: [auditEntry(ctx, 'tags_reordered', { tableName: 'tags', details: { groupId, order: next.map((t) => t.id) } })],
  })
}
