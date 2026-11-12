import { describe, expect, it } from 'vitest'
import {
  COLORS, ICONS, createAccount, createProject, defaultColor, makeKey, moveAccount, readAppearance, reorderAccounts,
  reorderProjects, resolveAppearance, updateAccount, updateProject, writeAppearance,
} from '../src/core'
import { ID, code, setup } from './helpers'

describe('ключи из названий', () => {
  it('транслитерация, уникальность, запасной вариант', () => {
    expect(makeKey('Приват Скарбничка', [])).toBe('privat-skarbnichka')
    expect(makeKey('Бизнес', ['biznes'])).toBe('biznes-2')
    expect(makeKey('Бизнес', ['biznes', 'biznes-2'])).toBe('biznes-3')
    expect(makeKey('Їжа та Євро', [])).toBe('yizha-ta-yevro')
    expect(makeKey('***', [], 'razdel')).toBe('razdel')
    expect(makeKey('Podnikateľský účet', [])).toBe('podnikatelsky-ucet')
    expect(makeKey('Майя', [])).toBe('mayya')
  })
})

describe('оформление', () => {
  it('читает только известное, чужие поля сохраняет', () => {
    expect(readAppearance({ color: 'blue', icon: 'bank', seed: 5 })).toEqual({ color: 'blue', icon: 'bank' })
    expect(readAppearance({ color: 'chartreuse', icon: 7 })).toEqual({ color: null, icon: null })
    expect(readAppearance(null)).toEqual({ color: null, icon: null })
    expect(writeAppearance({ seed: 5, color: 'red' }, { color: 'green', icon: null })).toEqual({ seed: 5, v: 1, color: 'green' })
  })
  it('значения по умолчанию стабильны и из набора', () => {
    expect(defaultColor('a-space')).toBe(defaultColor('a-space'))
    expect(Object.keys(COLORS)).toContain(defaultColor('x'))
    expect(resolveAppearance({}, 'a1', 'cash').icon).toBe('cash')
    expect(Object.keys(ICONS)).toContain(resolveAppearance({ icon: 'car' }, 'a1', 'bank').icon)
  })
})

describe('разделы, порядок, перенос', () => {
  it('создание: ключ из названия, порядок в конец, только владелец', async () => {
    const { ctx } = await setup()
    const p = await createProject(ctx, { name: 'Жена' })
    expect(p).toMatchObject({ key: 'zhena', sortOrder: 2 })
    expect(await code(createProject(ctx, { name: '  ' }))).toBe('INVALID_FIELD')
    expect(await code(createProject(ctx, { name: 'X', key: 'zhena' }))).toBe('DUPLICATE_KEY')
    const { ctx: viewer } = await setup({ owner: false })
    expect(await code(createProject(viewer, { name: 'Y' }))).toBe('FORBIDDEN')
  })
  it('переименование и порядок разделов', async () => {
    const { ctx, storage } = await setup()
    await updateProject(ctx, ID.lichnoe, { name: 'Моё' })
    await reorderProjects(ctx, [ID.biznes, ID.lichnoe])
    const ps = (await storage.list('projects')).sort((a, b) => a.sortOrder - b.sortOrder)
    expect(ps.map((p) => [p.id, p.name])).toEqual([[ID.biznes, 'Бизнес'], [ID.lichnoe, 'Моё']])
    expect(await code(reorderProjects(ctx, [ID.biznes]))).toBe('INVALID_FIELD')
    expect(await code(reorderProjects(ctx, [ID.biznes, ID.biznes]))).toBe('INVALID_FIELD')
  })
  it('порядок счетов внутри раздела', async () => {
    const { ctx, storage } = await setup()
    const ids = (await storage.list('accounts')).filter((a) => a.projectId === ID.lichnoe).map((a) => a.id)
    await reorderAccounts(ctx, ID.lichnoe, [...ids].reverse())
    const now = (await storage.list('accounts')).filter((a) => a.projectId === ID.lichnoe).sort((a, b) => a.sortOrder - b.sortOrder).map((a) => a.id)
    expect(now).toEqual([...ids].reverse())
    expect(await code(reorderAccounts(ctx, ID.lichnoe, ids.slice(1)))).toBe('INVALID_FIELD')
  })
  it('перенос счёта в другой раздел: в конец или на позицию, порядок целевого раздела цел', async () => {
    const { ctx, storage } = await setup()
    await moveAccount(ctx, ID.space, ID.biznes)
    let biz = (await storage.list('accounts')).filter((a) => a.projectId === ID.biznes).sort((a, b) => a.sortOrder - b.sortOrder)
    expect(biz.at(-1)!.id).toBe(ID.space)
    expect(biz.map((a) => a.sortOrder)).toEqual(biz.map((_, i) => i))
    await moveAccount(ctx, ID.space, ID.biznes, 0)
    biz = (await storage.list('accounts')).filter((a) => a.projectId === ID.biznes).sort((a, b) => a.sortOrder - b.sortOrder)
    expect(biz[0]!.id).toBe(ID.space)
    expect(await code(moveAccount(ctx, ID.space, 'нет'))).toBe('NOT_FOUND')
  })
  it('перенос не мешает закрытому периоду: закрытие общее', async () => {
    const { ctx } = await setup()
    const { closePeriod } = await import('../src/core')
    await closePeriod(ctx, { through: '2026-10-31' })
    await expect(moveAccount(ctx, ID.space, ID.biznes)).resolves.toBeTruthy()
  })
})

describe('создание счёта', () => {
  it('порядок в конце раздела, название и оформление правятся, доступ выдаётся владельцу', async () => {
    const { ctx, storage } = await setup()
    const batches: unknown[] = []
    const orig = storage.applyBatch.bind(storage)
    storage.applyBatch = async (b) => { batches.push(b); return orig(b) }
    const before = (await storage.list('accounts')).filter((a) => a.projectId === ID.lichnoe).length
    const a = await createAccount(ctx, {
      key: 'novyj', name: 'Новый', type: 'bank', projectId: ID.lichnoe, currencyKey: 'eur', countryKey: 'sk', trackingMode: 'balance_and_movements',
    })
    expect(a.sortOrder).toBeGreaterThanOrEqual(before)
    expect(batches[0]).toMatchObject({ grantOwnerAccess: [{ accountId: a.id, userId: 'u1' }] })
    const u = await updateAccount(ctx, a.id, { name: 'Моя карта', appearance: writeAppearance({}, { color: 'teal', icon: 'card' }) })
    expect(u.name).toBe('Моя карта')
    expect(readAppearance(u.appearance)).toEqual({ color: 'teal', icon: 'card' })
  })
})

describe('старые выгрузки', () => {
  it('разделам без порядка и оформления подставляются значения по умолчанию', async () => {
    const { parseDump } = await import('../src/core')
    const text = JSON.stringify({
      format: 'fin-control-dump', version: 1, exportedAt: 'x', auditLog: [],
      data: { projects: [{ id: 'p1', key: 'a', name: 'A' }, { id: 'p2', key: 'b', name: 'B', sortOrder: 7, appearance: { color: 'red' } }],
              periodLocks: [{ id: 'l1', seq: 1, lockedThrough: '2026-10-31', status: 'active' }] },
    })
    const d = parseDump(text)
    expect(d.data.projects).toEqual([
      { id: 'p1', key: 'a', name: 'A', sortOrder: 0, appearance: {} },
      { id: 'p2', key: 'b', name: 'B', sortOrder: 7, appearance: { color: 'red' } },
    ])
    expect(d.data.periodLocks[0]).toMatchObject({ projectId: null })
  })
})
