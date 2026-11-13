import { describe, expect, it } from 'vitest'
import { LAYOUT_KEY, newDividerId, projectItems, readLayout, saveProjectLayout, setAccountArchived, visibleItems, createAccount } from '../src/core'
import { ID, code, setup } from './helpers'

const active = async (s: Awaited<ReturnType<typeof setup>>) =>
  (await s.storage.list('accounts')).filter((a) => a.projectId === ID.lichnoe && !a.archivedAt).sort((a, b) => a.sortOrder - b.sortOrder)
const layoutOf = async (s: Awaited<ReturnType<typeof setup>>) => readLayout(await s.storage.list('appSettings'))

describe('разделители между счетами', () => {
  it('без раскладки порядок по sortOrder', async () => {
    const s = await setup()
    expect(projectItems({}, ID.lichnoe, await active(s))).toEqual([ID.space, ID.cashUah, ID.parents, ID.freedom])
  })

  it('разделитель сохраняется, порядок счетов идёт в sortOrder, итоги не затронуты', async () => {
    const s = await setup()
    const d = newDividerId(s.ctx)
    expect(d.startsWith('div:')).toBe(true)
    await saveProjectLayout(s.ctx, ID.lichnoe, [ID.cashUah, d, ID.space, ID.parents, ID.freedom])
    const lay = await layoutOf(s)
    expect(lay[ID.lichnoe]).toEqual([ID.cashUah, d, ID.space, ID.parents, ID.freedom])
    const items = projectItems(lay, ID.lichnoe, await active(s))
    expect(items).toEqual([ID.cashUah, d, ID.space, ID.parents, ID.freedom])
    expect((await active(s)).map((a) => a.id)).toEqual([ID.cashUah, ID.space, ID.parents, ID.freedom])
    expect((await s.storage.list('accounts')).length).toBe(5)   // разделитель не счёт
  })

  it('новый и вернувшийся из архива счёт встают в конец, исчезнувший счёт пропадает из раскладки', async () => {
    const s = await setup()
    const d = newDividerId(s.ctx)
    await saveProjectLayout(s.ctx, ID.lichnoe, [ID.space, d, ID.cashUah, ID.parents, ID.freedom])
    const n = await createAccount(s.ctx, { key: 'new_acc', name: 'Новый', type: 'bank', projectId: ID.lichnoe, currencyKey: 'eur', countryKey: 'sk', trackingMode: 'balance_and_movements' })
    expect(projectItems(await layoutOf(s), ID.lichnoe, await active(s))).toEqual([ID.space, d, ID.cashUah, ID.parents, ID.freedom, n.id])
    await setAccountArchived(s.ctx, ID.cashUah, true)
    expect(projectItems(await layoutOf(s), ID.lichnoe, await active(s))).toEqual([ID.space, d, ID.parents, ID.freedom, n.id])
  })

  it('без разделителей запись раскладки раздела удаляется', async () => {
    const s = await setup()
    const d = newDividerId(s.ctx)
    await saveProjectLayout(s.ctx, ID.lichnoe, [ID.space, d, ID.cashUah, ID.parents, ID.freedom])
    await saveProjectLayout(s.ctx, ID.lichnoe, [ID.space, ID.cashUah, ID.parents, ID.freedom])
    expect((await layoutOf(s))[ID.lichnoe]).toBeUndefined()
    expect((await s.storage.list('appSettings')).some((r) => r.key === LAYOUT_KEY)).toBe(true)
  })

  it('проверки: все счета раздела по одному разу, чужой счёт нельзя, только владелец', async () => {
    const s = await setup()
    expect(await code(saveProjectLayout(s.ctx, ID.lichnoe, [ID.space, ID.cashUah]))).toBe('INVALID_FIELD')
    expect(await code(saveProjectLayout(s.ctx, ID.lichnoe, [ID.space, ID.space, ID.cashUah, ID.parents, ID.freedom]))).toBe('INVALID_FIELD')
    expect(await code(saveProjectLayout(s.ctx, ID.lichnoe, [ID.space, ID.cashUah, ID.parents, ID.mono]))).toBe('INVALID_FIELD')
    const d = newDividerId(s.ctx)
    expect(await code(saveProjectLayout(s.ctx, ID.lichnoe, [ID.space, d, d, ID.cashUah, ID.parents, ID.freedom]))).toBe('INVALID_FIELD')
    const other = await setup({ owner: false })
    expect(await code(saveProjectLayout(other.ctx, ID.lichnoe, [ID.space, ID.cashUah, ID.parents, ID.freedom]))).toBe('FORBIDDEN')
  })

  it('запись попадает в журнал, в выгрузку и читается устойчиво к мусору', async () => {
    const s = await setup()
    const d = newDividerId(s.ctx)
    await saveProjectLayout(s.ctx, ID.lichnoe, [ID.space, d, ID.cashUah, ID.parents, ID.freedom])
    expect((await s.storage.listAudit()).some((a) => a.action === 'layout_changed')).toBe(true)
    expect((await s.storage.exportAll()).data.appSettings.some((r) => r.key === LAYOUT_KEY)).toBe(true)
    expect(readLayout([{ key: LAYOUT_KEY, value: 5 }])).toEqual({})
    expect(readLayout([{ key: LAYOUT_KEY, value: { p: ['a', 3, 'b'], q: 'x' } }])).toEqual({ p: ['a', 'b'] })
  })

  it('для показа лишние разделители (в начале, в конце, подряд) скрываются', () => {
    expect(visibleItems(['div:1', 'a', 'div:2', 'div:3', 'b', 'div:4'])).toEqual(['a', 'div:2', 'b'])
    expect(visibleItems(['div:1'])).toEqual([])
  })
})
