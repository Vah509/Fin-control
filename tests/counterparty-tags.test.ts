import { describe, expect, it } from 'vitest'
import { createTag, createTagGroup, setTagArchived } from '../src/core'
import { applyCounterpartyFile } from '../src/core/statements'
import { setup } from './helpers'

const row = (n: number, text: string, extra: Partial<{ resolved: string; newName: string; tag: string }> = {}) => ({ row: n, text, resolved: '', newName: '', iban: null, ...extra })

async function base() {
  const { ctx } = await setup()
  const g = await createTagGroup(ctx, { name: 'Продукты' })
  const g2 = await createTagGroup(ctx, { name: 'Кафе' })
  const lidl = await createTag(ctx, { groupId: g.id, name: 'Супермаркет' })
  await createTag(ctx, { groupId: g.id, name: 'Рынок' })
  await createTag(ctx, { groupId: g2.id, name: 'Рынок' })
  return { ctx, lidl }
}

describe('тег новому контрагенту при загрузке файла', () => {
  it('новый контрагент получает тег (полная подпись и уникальное короткое имя)', async () => {
    const { ctx, lidl } = await base()
    const r = await applyCounterpartyFile(ctx, [row(2, 'Lidl 165', { tag: 'Продукты › Супермаркет' }), row(3, 'Kaufland', { tag: 'супермаркет' }), row(4, 'Bolt')])
    expect(r).toMatchObject({ created: 3, tagsSet: 2 })
    const cps = await ctx.storage.list('counterparties')
    expect(cps.find((c) => c.name === 'Lidl 165')!.defaultTagId).toBe(lidl.id)
    expect(cps.find((c) => c.name === 'Kaufland')!.defaultTagId).toBe(lidl.id)
    expect(cps.find((c) => c.name === 'Bolt')!.defaultTagId).toBeNull()
  })
  it('опознанному контрагенту тег ставится, пустая колонка ничего не меняет', async () => {
    const { ctx, lidl } = await base()
    await applyCounterpartyFile(ctx, [row(2, 'Lidl 165')])
    await applyCounterpartyFile(ctx, [row(2, 'Lidl 165', { resolved: 'Lidl 165', tag: 'Продукты › Супермаркет' })])
    expect((await ctx.storage.list('counterparties'))[0]!.defaultTagId).toBe(lidl.id)
    const r = await applyCounterpartyFile(ctx, [row(2, 'Lidl 165', { resolved: 'Lidl 165' })])
    expect(r.tagsSet).toBe(0)
    expect((await ctx.storage.list('counterparties'))[0]!.defaultTagId).toBe(lidl.id)
  })
  it('ошибки: неизвестный, неоднозначный, архивный тег, разные теги у одного контрагента; ничего не записывается', async () => {
    const { ctx, lidl } = await base()
    await expect(applyCounterpartyFile(ctx, [row(2, 'A', { tag: 'Нет такого' })])).rejects.toMatchObject({ code: 'COUNTERPARTY_FILE_INVALID' })
    await expect(applyCounterpartyFile(ctx, [row(2, 'A', { tag: 'Рынок' })])).rejects.toThrow(/нескольких группах/)
    await setTagArchived(ctx, lidl.id, true)
    await expect(applyCounterpartyFile(ctx, [row(2, 'A', { tag: 'Продукты › Супермаркет' })])).rejects.toThrow(/в архиве/)
    await expect(applyCounterpartyFile(ctx, [row(2, 'Lidl 165', { newName: 'Lidl', tag: 'Продукты › Рынок' }), row(3, 'Lidl 185', { newName: 'Lidl', tag: 'Кафе › Рынок' })])).rejects.toThrow(/разные теги/)
    expect(await ctx.storage.list('counterparties')).toHaveLength(0)
  })
})
