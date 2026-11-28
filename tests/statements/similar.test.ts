import { describe, expect, it } from 'vitest'
import { similarity, nameTokens } from '../../src/core/statements/similar'

describe('похожие названия', () => {
  it('слова: без регистра, диакритики и хвоста после запятой', () => {
    expect(nameTokens('LIDL Bratislava, Ružinov')).toEqual(['lidl', 'bratislava'])
    expect(nameTokens('Bloom bakery NIVY, Bratislava')).toEqual(['bloom', 'bakery', 'nivy'])
  })
  it('вхождение слов считается похожим', () => {
    expect(similarity('LIDL', 'Lidl dakuje 165')).toBeGreaterThan(0)
    expect(similarity('Bloom bakery NIVY, Bratislava', 'Bloom bakery')).toBeGreaterThan(0)
  })
  it('разные люди с одной фамилией и разные магазины не склеиваются', () => {
    expect(similarity('Довженко А.', 'Довженко В.')).toBe(0)
    expect(similarity('Kaufland', 'Lidl')).toBe(0)
  })
})
