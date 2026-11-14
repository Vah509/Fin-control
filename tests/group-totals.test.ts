import { describe, expect, it } from 'vitest'
import { groupTotalsByDividers, readAccountsView, saveAccountsView, freshAccountsView, exportDump, type SnapshotRow } from '../src/core'
import { ID, code, setup } from './helpers'

const row = (id: string, minor: number | null): SnapshotRow => ({
  accountId: id, key: id, name: id, type: 'cash', projectId: 'p', countryKey: 'sk', holder: null, institutionId: null, currencyKey: 'eur',
  balanceMinor: minor ?? 0, unaccountedMinor: 0,
  balance: { minor, hasRate: minor !== null }, unaccounted: { minor: 0, hasRate: true },
}) as SnapshotRow

describe('суммы групп между разделителями', () => {
  it('группа = счета между разделителями; пустые группы и повторные разделители пропускаются', () => {
    const rows = [row('a', 100), row('b', 200), row('c', 300), row('d', 400)]
    const g = groupTotalsByDividers(['a', 'div:1', 'b', 'c', 'div:2', 'div:3', 'd'], rows, 'eur')
    expect(g.map((x) => [x.ids, x.baseMinor, x.complete])).toEqual([[['a'], 100, true], [['b', 'c'], 500, true], [['d'], 400, true]])
  })
  it('без разделителей одна группа; нет курса: complete=false', () => {
    const g = groupTotalsByDividers(['a', 'b'], [row('a', 100), row('b', null)], 'eur')
    expect(g).toHaveLength(1)
    expect(g[0]).toMatchObject({ baseMinor: 100, complete: false })
  })
  it('счета без строки среза (скрытые) не считаются', () => {
    expect(groupTotalsByDividers(['x', 'div:1', 'a'], [row('a', 5)], 'eur').map((x) => x.ids)).toEqual([['a']])
  })
})

describe('настройка страницы «Счета»', () => {
  it('нет записи или мусор: по умолчанию', () => {
    expect(readAccountsView([])).toEqual(freshAccountsView())
    expect(readAccountsView([{ key: 'accounts_view', value: 5 }])).toEqual(freshAccountsView())
  })
  it('сохранение, чтение, журнал, выгрузка; повтор ничего не пишет', async () => {
    const s = await setup()
    const next = { hiddenAccounts: [ID.mono], showGroupTotals: false }
    await saveAccountsView(s.ctx, next)
    await saveAccountsView(s.ctx, next)
    expect(readAccountsView(await s.storage.list('appSettings'))).toEqual(next)
    expect((await s.storage.listAudit({})).filter((a) => a.recordId === 'accounts_view')).toHaveLength(1)
    expect((await exportDump(s.ctx)).data.appSettings.some((r) => r.key === 'accounts_view')).toBe(true)
  })
  it('не владелец: FORBIDDEN', async () => {
    const s = await setup({ owner: false })
    expect(await code(saveAccountsView(s.ctx, freshAccountsView()))).toBe('FORBIDDEN')
  })
})
