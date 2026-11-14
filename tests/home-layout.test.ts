import { describe, expect, it } from 'vitest'
import { DEFAULT_HOME, exportDump, freshHome, normalizeOrder, orderProjects, readHomeSettings, saveHomeSettings } from '../src/core'
import { ID, code, setup } from './helpers'

describe('настройка Главной', () => {
  it('нет записи или мусор: значения по умолчанию (курсы, счета, общий итог)', () => {
    expect(readHomeSettings([])).toEqual(DEFAULT_HOME)
    expect(readHomeSettings([{ key: 'home_layout', value: 'x' }])).toEqual(DEFAULT_HOME)
    expect(DEFAULT_HOME.order).toEqual(['rates', 'accounts', 'total'])
  })
  it('порядок: лишнее и повторы убираются, недостающее добавляется в конец', () => {
    expect(normalizeOrder(['total', 'x', 'total', 'rates'])).toEqual(['total', 'rates', 'accounts'])
    expect(normalizeOrder(['sections', 'accounts'])).toEqual(['accounts', 'rates', 'total'])
  })
  it('первая версия настройки читается: showSections становится showSectionTotals', () => {
    const h = readHomeSettings([{ key: 'home_layout', value: { order: ['rates', 'accounts', 'sections', 'total'], hiddenAccounts: ['a'], showSections: false, showTotal: false } }])
    expect(h).toMatchObject({ order: ['rates', 'accounts', 'total'], hiddenAccounts: ['a'], showSectionTotals: false, showTotal: false, showDividers: true })
  })
  it('разделы Главной: свой порядок, остальные следом', () => {
    const ps = [{ id: 'a' }, { id: 'b' }, { id: 'c' }]
    expect(orderProjects(['c', 'x', 'c'], ps).map((p) => p.id)).toEqual(['c', 'a', 'b'])
    expect(orderProjects([], ps).map((p) => p.id)).toEqual(['a', 'b', 'c'])
  })
  it('сохранение и чтение (свой порядок и разделители), запись в журнал, повтор ничего не пишет', async () => {
    const s = await setup()
    const next = { ...freshHome(), order: ['total', 'rates', 'accounts'] as never, hiddenAccounts: [ID.mono], showTotal: false,
      showSectionTotals: false, projectOrder: [ID.biznes], layout: { [ID.lichnoe]: [ID.cashUah, 'div:1', ID.space] } }
    await saveHomeSettings(s.ctx, next)
    expect(readHomeSettings(await s.storage.list('appSettings'))).toEqual(next)
    const count = async () => (await s.storage.listAudit({})).filter((a) => a.recordId === 'home_layout').length
    expect(await count()).toBe(1)
    await saveHomeSettings(s.ctx, next)
    expect(await count()).toBe(1)
  })
  it('экран «Счета» не затронут: порядок Главной хранится отдельно', async () => {
    const s = await setup()
    await saveHomeSettings(s.ctx, { ...freshHome(), layout: { [ID.lichnoe]: [ID.cashUah, ID.space] } })
    expect((await s.storage.list('appSettings')).some((r) => r.key === 'account_layout')).toBe(false)
    expect((await s.storage.list('accounts')).find((a) => a.id === ID.space)!.sortOrder).toBe(1)
  })
  it('не владелец: FORBIDDEN', async () => {
    const s = await setup({ owner: false })
    expect(await code(saveHomeSettings(s.ctx, freshHome()))).toBe('FORBIDDEN')
  })
  it('настройка попадает в выгрузку JSON', async () => {
    const s = await setup()
    await saveHomeSettings(s.ctx, { ...freshHome(), showTotal: false })
    expect((await exportDump(s.ctx)).data.appSettings.some((r) => r.key === 'home_layout')).toBe(true)
  })
})
