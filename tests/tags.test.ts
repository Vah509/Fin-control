import { describe, expect, it } from 'vitest'
import { createTag, createTagGroup, moveTag, moveTagGroup, renameTagGroup, setTagArchived, tagTree, updateTag } from '../src/core'
import { setup } from './helpers'

async function base() {
  const s = await setup()
  const ctx = s.ctx
  const food = await createTagGroup(ctx, { name: 'Продукты' })
  const cafe = await createTagGroup(ctx, { name: 'Кафе' })
  await ctx.storage.applyBatch({ put: { tagGroups: [{ id: 'g-once', key: 'razovye', name: 'Разовые', isService: true, sortOrder: 99 }] } })
  return { ctx, food, cafe }
}
const names = async (ctx: Awaited<ReturnType<typeof base>>['ctx']) =>
  tagTree(await ctx.storage.list('tagGroups'), await ctx.storage.list('tags')).map((x) => [x.group.name, x.tags.map((t) => t.name)])

describe('теги', () => {
  it('создание группы и тега, ключи, порядок, служебная в конце', async () => {
    const { ctx, food } = await base()
    const t = await createTag(ctx, { groupId: food.id, name: '  Супермаркет ' })
    await createTag(ctx, { groupId: food.id, name: 'Рынок' })
    expect(t.name).toBe('Супермаркет')
    expect(t.key).toBe('supermarket')
    expect(await names(ctx)).toEqual([['Продукты', ['Супермаркет', 'Рынок']], ['Кафе', []], ['Разовые', []]])
  })
  it('дубли названий запрещены (без учёта регистра), в другой группе можно', async () => {
    const { ctx, food, cafe } = await base()
    await createTag(ctx, { groupId: food.id, name: 'Рынок' })
    await expect(createTag(ctx, { groupId: food.id, name: 'рынок' })).rejects.toMatchObject({ code: 'DUPLICATE_KEY' })
    await createTag(ctx, { groupId: cafe.id, name: 'Рынок' })
    await expect(createTagGroup(ctx, { name: 'кафе' })).rejects.toMatchObject({ code: 'DUPLICATE_KEY' })
    await expect(createTag(ctx, { groupId: food.id, name: '   ' })).rejects.toMatchObject({ code: 'INVALID_FIELD' })
  })
  it('перенос тега в другую группу сохраняет id (привязки контрагентов не теряются)', async () => {
    const { ctx, food, cafe } = await base()
    const t = await createTag(ctx, { groupId: food.id, name: 'Кофе' })
    const moved = await updateTag(ctx, t.id, { groupId: cafe.id, name: 'Кофе и перекусы' })
    expect(moved.id).toBe(t.id)
    expect(await names(ctx)).toEqual([['Продукты', []], ['Кафе', ['Кофе и перекусы']], ['Разовые', []]])
  })
  it('порядок: сдвиг тегов и групп, на краю ничего не меняется', async () => {
    const { ctx, food, cafe } = await base()
    const a = await createTag(ctx, { groupId: food.id, name: 'A' })
    const b = await createTag(ctx, { groupId: food.id, name: 'B' })
    await moveTag(ctx, b.id, -1)
    await moveTag(ctx, b.id, -1)
    expect((await names(ctx))[0]).toEqual(['Продукты', ['B', 'A']])
    await moveTag(ctx, a.id, 1)
    expect((await names(ctx))[0]).toEqual(['Продукты', ['B', 'A']])
    await moveTagGroup(ctx, cafe.id, -1)
    expect((await names(ctx)).map((x) => x[0])).toEqual(['Кафе', 'Продукты', 'Разовые'])
  })
  it('служебная группа: нельзя переименовать и двигать', async () => {
    const { ctx } = await base()
    await expect(renameTagGroup(ctx, 'g-once', 'Другое')).rejects.toMatchObject({ code: 'INVALID_FIELD' })
    await expect(moveTagGroup(ctx, 'g-once', -1)).rejects.toMatchObject({ code: 'INVALID_FIELD' })
    await createTag(ctx, { groupId: 'g-once', name: 'Поездка' })
  })
  it('архив и возврат; журнал; не владелец не может', async () => {
    const { ctx, food } = await base()
    const t = await createTag(ctx, { groupId: food.id, name: 'Рынок' })
    expect((await setTagArchived(ctx, t.id, true)).archivedAt).not.toBeNull()
    expect((await setTagArchived(ctx, t.id, false)).archivedAt).toBeNull()
    const log = (await ctx.storage.listAudit()).map((e) => e.action)
    expect(log).toEqual(expect.arrayContaining(['tag_created', 'tag_archived', 'tag_restored']))
    const other = await setup({ owner: false })
    await expect(createTagGroup(other.ctx, { name: 'X' })).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })
})

import { reorderTagGroups, reorderTags } from '../src/core'
describe('порядок перетаскиванием', () => {
  it('видимые теги меняют порядок, архивный остаётся на месте; группы без служебной', async () => {
    const { ctx, food, cafe } = await base()
    const a = await createTag(ctx, { groupId: food.id, name: 'A' })
    const b = await createTag(ctx, { groupId: food.id, name: 'B' })
    const c = await createTag(ctx, { groupId: food.id, name: 'C' })
    await setTagArchived(ctx, b.id, true)
    await reorderTags(ctx, food.id, [c.id, a.id])
    expect((await names(ctx))[0]).toEqual(['Продукты', ['C', 'B', 'A']])
    await reorderTagGroups(ctx, [cafe.id, food.id])
    expect((await names(ctx)).map((x) => x[0])).toEqual(['Кафе', 'Продукты', 'Разовые'])
    await expect(reorderTagGroups(ctx, ['g-once'])).rejects.toMatchObject({ code: 'INVALID_FIELD' })
    await expect(reorderTags(ctx, food.id, [a.id, a.id])).rejects.toMatchObject({ code: 'INVALID_FIELD' })
  })
})
