import { describe, expect, it } from 'vitest'
import { DEFAULT_HOME, exportDump, normalizeOrder, readHomeSettings, saveHomeSettings } from '../src/core'
import { ID, code, setup } from './helpers'

describe('настройка Главной', () => {
  it('нет записи или мусор: значения по умолчанию (курсы, счета, итоги по разделам, общий итог)', () => {
    expect(readHomeSettings([])).toEqual(DEFAULT_HOME)
    expect(readHomeSettings([{ key: 'home_layout', value: 'x' }])).toEqual(DEFAULT_HOME)
    expect(DEFAULT_HOME.order).toEqual(['rates', 'accounts', 'sections', 'total'])
  })
  it('порядок: лишнее и повторы убираются, недостающее добавляется в конец', () => {
    expect(normalizeOrder(['total', 'x', 'total', 'rates'])).toEqual(['total', 'rates', 'accounts', 'sections'])
    expect(normalizeOrder(null)).toEqual(DEFAULT_HOME.order)
  })
  it('сохранение и чтение, запись в журнал, повтор без изменений ничего не пишет', async () => {
    const s = await setup()
    const next = { order: ['total', 'rates', 'accounts', 'sections'] as const, hiddenAccounts: [ID.mono], showTotal: false, showSections: true, showDividers: false }
    await saveHomeSettings(s.ctx, { ...next, order: [...next.order] })
    expect(readHomeSettings(await s.storage.list('appSettings'))).toEqual({ ...next, order: [...next.order] })
    const n = (await s.storage.listAudit({})).filter((a) => a.recordId === 'home_layout').length
    expect(n).toBe(1)
    await saveHomeSettings(s.ctx, { ...next, order: [...next.order] })
    expect((await s.storage.listAudit({})).filter((a) => a.recordId === 'home_layout').length).toBe(1)
  })
  it('не владелец: FORBIDDEN', async () => {
    const s = await setup({ owner: false })
    expect(await code(saveHomeSettings(s.ctx, DEFAULT_HOME))).toBe('FORBIDDEN')
  })
  it('настройка попадает в выгрузку JSON', async () => {
    const s = await setup()
    await saveHomeSettings(s.ctx, { ...DEFAULT_HOME, order: [...DEFAULT_HOME.order], showTotal: false })
    const dump = await exportDump(s.ctx)
    expect(dump.data.appSettings.some((r) => r.key === 'home_layout')).toBe(true)
  })
})
