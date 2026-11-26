import { describe, expect, it } from 'vitest'
import { exportDump } from '../src/core'
import { setup } from './helpers'

describe('balance_periods: хранилище (шаг 5б, версия 0.2.36)', () => {
  it('период записывается в хранилище и попадает в выгрузку', async () => {
    const { ctx, storage } = await setup()
    const acc = (await storage.list('accounts'))[0]!
    const p = {
      id: 'bp1', accountId: acc.id, periodStart: '2026-07-01', periodEnd: '2026-07-31', openingMinor: 119944, closingMinor: 416896,
      source: 'statement' as const, ref: 'file-hash', status: 'active' as const, note: null, createdBy: null, createdAt: '2026-11-26T10:00:00.000Z',
    }
    await storage.applyBatch({ put: { balancePeriods: [p] } })
    expect(await storage.list('balancePeriods')).toEqual([p])
    const dump = await exportDump(ctx)
    expect(dump.data['balancePeriods']).toHaveLength(1)
  })
})
