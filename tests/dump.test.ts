import { describe, expect, it } from 'vitest'
import { closePeriod, commitBalanceEntry, exportDump, mergeDump, parseDump } from '../src/core'
import { code, setup, ID } from './helpers'

describe('выгрузка и слияние', () => {
  it('выгрузка из одной базы сливается в другую', async () => {
    const a = await setup(); const b = await setup()
    await commitBalanceEntry(a.ctx, { accountId: ID.space, asOf: '2026-10-01T00:00:00Z', newBalanceMinor: 124558, createAdjustment: true })
    const dump = parseDump(JSON.stringify(await exportDump(a.ctx)))
    const r = await mergeDump(b.ctx, dump)
    expect(r.rows).toBeGreaterThan(5)
    expect((await b.storage.listTransactions({ accountId: ID.space })).map((t) => t.amountMinor)).toEqual([124558])
    expect((await b.storage.listAudit()).some((l) => l.action === 'dump_merged')).toBe(true)
  })
  it('чужой файл и не владелец отвергаются', async () => {
    expect(await code((async () => parseDump('{"a":1}'))())).toBe('INVALID_FIELD')
    expect(await code((async () => parseDump('не json'))())).toBe('INVALID_FIELD')
    const s = await setup({ owner: false })
    expect(await code(exportDump(s.ctx))).toBe('FORBIDDEN')
  })
  it('при закрытом периоде слияние запрещено', async () => {
    const s = await setup()
    await closePeriod(s.ctx, { projectId: ID.lichnoe, through: '2026-09-30' })
    expect(await code(mergeDump(s.ctx, await s.storage.exportAll()))).toBe('PERIOD_LOCKED')
  })
})
