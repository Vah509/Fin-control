import { describe, expect, it } from 'vitest'
import { canGoBack, readNavState } from '../src/ui/navHistory'

describe('история навигации', () => {
  it('читает корректное состояние записи', () => {
    expect(readNavState({ idx: 2, page: 'account', accountId: 'a1' })).toEqual({ idx: 2, page: 'account', accountId: 'a1' })
    expect(readNavState({ idx: 0, page: 'home' })).toEqual({ idx: 0, page: 'home', accountId: undefined })
  })
  it('знает экраны настроек (назад ведёт в меню, а не в «Прочее»)', () => {
    for (const page of ['settings', 'baseCurrency', 'homeSettings'] as const) {
      expect(readNavState({ idx: 2, page })?.page).toBe(page)
    }
  })
  it('чужие и испорченные записи игнорирует', () => {
    for (const bad of [null, undefined, 'x', 5, {}, { idx: 1 }, { page: 'home' }, { idx: -1, page: 'home' }, { idx: 1.5, page: 'home' }, { idx: 1, page: 'unknown' }]) {
      expect(readNavState(bad)).toBeNull()
    }
  })
  it('назад возможен только внутри приложения (idx > 0)', () => {
    expect(canGoBack({ idx: 0, page: 'home' })).toBe(false)
    expect(canGoBack({ idx: 1, page: 'accounts' })).toBe(true)
    expect(canGoBack(null)).toBe(false)
  })
})
