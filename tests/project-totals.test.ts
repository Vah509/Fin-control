import { describe, expect, it } from 'vitest'
import {
  projectTotals, totalItems, readHomeSettings, saveHomeSettings, freshHome, exportDump, type SnapshotRow,
} from '../src/core'
import { setup } from './helpers'

const row = (id: string, project: string, minor: number | null, cur = 'eur'): SnapshotRow => ({
  accountId: id, key: id, name: id, type: 'cash', projectId: project, countryKey: 'sk', holder: null, institutionId: null, currencyKey: cur,
  balanceMinor: minor ?? 0, unaccountedMinor: 0,
  balance: { minor, hasRate: minor !== null }, unaccounted: { minor: 0, hasRate: true },
}) as SnapshotRow

describe('общий итог по разделам', () => {
  const rows = [row('a', 'p1', 100), row('b', 'p1', 50), row('c', 'p2', 300), row('d', 'p3', 1000), row('e', 'p4', 7)]
  it('группы между разделителями; итог только по включённым разделам', () => {
    const r = projectTotals(['p1', 'p2', 'div:1', 'p3'], rows, 'eur')
    expect(r.split).toBe(true)
    expect(r.groups.map((g) => [g.projects.map((p) => p.projectId), g.baseMinor])).toEqual([[['p1', 'p2'], 450], [['p3'], 1000]])
    expect(r.groups[0]!.projects.map((p) => p.baseMinor)).toEqual([150, 300])
    expect(r.totals.baseMinor).toBe(1450)           // p4 не выбран, в итог не входит
  })
  it('без разделителей одна группа; лишние разделители и пустые разделы пропускаются', () => {
    expect(projectTotals(['p1', 'p2'], rows, 'eur').split).toBe(false)
    const r = projectTotals(['div:1', 'p1', 'div:2', 'div:3', 'zzz', 'div:4', 'p2', 'div:5'], rows, 'eur')
    expect(r.groups.map((g) => g.baseMinor)).toEqual([150, 300])
  })
  it('нет курса: группа и итог неполные, сумма по валютам считается', () => {
    const r = projectTotals(['p1', 'p2'], [row('a', 'p1', 100), row('c', 'p2', null, 'uah')], 'eur')
    expect(r.groups[0]!.complete).toBe(false)
    expect(r.totals.complete).toBe(false)
    expect(r.totals.byCurrency.map((t) => t.currencyKey)).toEqual(['eur', 'uah'])
  })
})

describe('состав блока «Общий итог»', () => {
  const projects = [{ id: 'p1' }, { id: 'p2' }, { id: 'p3' }]
  const base = { totalHidden: [] as string[], totalLayout: [] as string[], projectOrder: [] as string[] }
  it('по умолчанию все разделы в порядке Главной', () => {
    expect(totalItems(base, projects)).toEqual(['p1', 'p2', 'p3'])
    expect(totalItems({ ...base, projectOrder: ['p3'] }, projects)).toEqual(['p3', 'p1', 'p2'])
  })
  it('сохранённый порядок, разделители; скрытые, исчезнувшие и повторы убираются; новые в конец', () => {
    expect(totalItems({ ...base, totalHidden: ['p2'], totalLayout: ['p3', 'div:1', 'p2', 'gone', 'p3', 'p1'] }, projects)).toEqual(['p3', 'div:1', 'p1'])
    expect(totalItems({ ...base, totalLayout: ['p2', 'div:1'] }, projects)).toEqual(['p2', 'div:1', 'p1', 'p3'])
  })
  it('сохранение, чтение, старая настройка без новых полей, выгрузка', async () => {
    expect(readHomeSettings([{ key: 'home_layout', value: { showTotal: true } }])).toMatchObject({ totalHidden: [], totalLayout: [] })
    const s = await setup()
    const next = { ...freshHome(), totalHidden: ['p2'], totalLayout: ['p1', 'div:x', 'p3'] }
    await saveHomeSettings(s.ctx, next)
    expect(readHomeSettings(await s.storage.list('appSettings'))).toEqual(next)
    expect((await exportDump(s.ctx)).data.appSettings.some((r) => r.key === 'home_layout')).toBe(true)
  })
})
