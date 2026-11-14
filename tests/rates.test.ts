import { describe, expect, it } from 'vitest'
import { getDisplayRates } from '../src/core'
import { rate, setup } from './helpers'

const by = (l: Awaited<ReturnType<typeof getDisplayRates>>, f: string, t: string) => l.find((r) => r.from === f && r.to === t)!

describe('getDisplayRates', () => {
  it('рост: прямая пара, изменение к предыдущему дню', async () => {
    const s = await setup()
    await s.storage.applyBatch({ put: { fxRates: [rate('1', '2026-11-12', 'eur', 'uah', '48.70'), rate('2', '2026-11-13', 'eur', 'uah', '48.82')] } })
    const r = by(await getDisplayRates(s.ctx, '2026-11-13'), 'eur', 'uah')
    expect(r).toMatchObject({ valueScaled: 4882, previousScaled: 4870, previousDate: '2026-11-12', deltaScaled: 12 })
  })
  it('падение: отрицательное изменение', async () => {
    const s = await setup()
    await s.storage.applyBatch({ put: { fxRates: [rate('1', '2026-11-12', 'usd', 'uah', '42.10'), rate('2', '2026-11-13', 'usd', 'uah', '41.95')] } })
    expect(by(await getDisplayRates(s.ctx, '2026-11-13'), 'usd', 'uah').deltaScaled).toBe(-15)
  })
  it('нет предыдущего курса: изменение null; нет курса вообще: значение null', async () => {
    const s = await setup()
    await s.storage.applyBatch({ put: { fxRates: [rate('1', '2026-11-13', 'eur', 'uah', '48.8')] } })
    const l = await getDisplayRates(s.ctx, '2026-11-13')
    expect(by(l, 'eur', 'uah')).toMatchObject({ valueScaled: 4880, previousScaled: null, deltaScaled: null })
    expect(by(l, 'usd', 'uah')).toMatchObject({ valueScaled: null, deltaScaled: null })
  })
  it('сегодня курса нет: берётся последний известный, предыдущий это день раньше него', async () => {
    const s = await setup()
    await s.storage.applyBatch({ put: { fxRates: [rate('1', '2026-11-10', 'eur', 'uah', '48.0'), rate('2', '2026-11-12', 'eur', 'uah', '48.5')] } })
    expect(by(await getDisplayRates(s.ctx, '2026-11-14'), 'eur', 'uah')).toMatchObject({ valueScaled: 4850, previousScaled: 4800, deltaScaled: 50 })
  })
  it('кросс-курс EUR/USD через гривну, 4 знака; обратная пара тоже работает', async () => {
    const s = await setup()
    await s.storage.applyBatch({ put: {
      appSettings: [{ key: 'fx_pivot_currency', value: 'uah' }],
      fxRates: [
        rate('1', '2026-11-12', 'eur', 'uah', '48'), rate('2', '2026-11-12', 'uah', 'usd', String(1 / 40)),
        rate('3', '2026-11-13', 'eur', 'uah', '48'), rate('4', '2026-11-13', 'usd', 'uah', '40'),
      ] } })
    expect(by(await getDisplayRates(s.ctx, '2026-11-13'), 'eur', 'usd')).toMatchObject({ valueScaled: 12000, previousScaled: 12000, deltaScaled: 0 })
  })
})
