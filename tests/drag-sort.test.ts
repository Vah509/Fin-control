import { describe, expect, it } from 'vitest'
import { moveItem, shiftFor, targetIndex } from '../src/ui/dragSort'

// Три строки высотой 100, середины 50, 150, 250
const mids = [50, 150, 250]

describe('targetIndex', () => {
  it('на месте, пока не пересекли середину соседа', () => {
    expect(targetIndex(mids, 1, 150)).toBe(1)
    expect(targetIndex(mids, 1, 140)).toBe(1)
    expect(targetIndex(mids, 1, 160)).toBe(1)
  })
  it('вверх, когда середина ушла выше середины верхнего соседа', () => {
    expect(targetIndex(mids, 1, 49)).toBe(0)
    expect(targetIndex(mids, 2, 100)).toBe(1)
    expect(targetIndex(mids, 2, 10)).toBe(0)
  })
  it('вниз, когда середина ушла ниже середины нижнего соседа', () => {
    expect(targetIndex(mids, 1, 251)).toBe(2)
    expect(targetIndex(mids, 0, 160)).toBe(1)
    expect(targetIndex(mids, 0, 400)).toBe(2)
  })
  it('граничные значения (равенство) не переносят', () => {
    expect(targetIndex(mids, 0, 150)).toBe(0)
    expect(targetIndex(mids, 2, 150)).toBe(2)
  })
  it('один элемент', () => { expect(targetIndex([50], 0, 999)).toBe(0) })
})

describe('moveItem', () => {
  it('переносит вниз и вверх', () => {
    expect(moveItem(['a', 'b', 'c', 'd'], 0, 2)).toEqual(['b', 'c', 'a', 'd'])
    expect(moveItem(['a', 'b', 'c', 'd'], 3, 1)).toEqual(['a', 'd', 'b', 'c'])
  })
  it('без изменений при том же или неверном индексе', () => {
    const l = ['a', 'b']
    expect(moveItem(l, 1, 1)).toBe(l)
    expect(moveItem(l, 0, 5)).toBe(l)
    expect(moveItem(l, -1, 0)).toBe(l)
  })
  it('не меняет исходный список', () => {
    const l = ['a', 'b', 'c']
    moveItem(l, 0, 2)
    expect(l).toEqual(['a', 'b', 'c'])
  })
})

describe('shiftFor', () => {
  it('при переносе вниз соседи между from и to сдвигаются вверх', () => {
    expect([0, 1, 2, 3].map((i) => shiftFor(i, 0, 2, 100))).toEqual([0, -100, -100, 0])
  })
  it('при переносе вверх соседи между to и from сдвигаются вниз', () => {
    expect([0, 1, 2, 3].map((i) => shiftFor(i, 3, 1, 100))).toEqual([0, 100, 100, 0])
  })
  it('без переноса сдвигов нет', () => {
    expect([0, 1, 2].map((i) => shiftFor(i, 1, 1, 100))).toEqual([0, 0, 0])
  })
  it('итоговый порядок совпадает с moveItem', () => {
    const ids = ['a', 'b', 'c', 'd'], from = 0, to = 2
    const byShift = ids.map((id, i) => ({ id, pos: i + (i === from ? to - from : shiftFor(i, from, to, 1)) })).sort((x, y) => x.pos - y.pos).map((x) => x.id)
    expect(byShift).toEqual(moveItem(ids, from, to))
  })
})
