import { useCallback, useEffect, useRef, useState } from 'react'
import type { CSSProperties, PointerEvent as ReactPointerEvent } from 'react'

/** Чистая логика перетаскивания (проверяется тестами без браузера). */

/** Новый индекс перетаскиваемого элемента: по середине его текущего положения относительно середин остальных. */
export function targetIndex(mids: number[], from: number, center: number): number {
  let to = from
  for (let i = 0; i < from; i++) if (center < mids[i]!) { to = i; break }
  if (to === from) for (let i = mids.length - 1; i > from; i--) if (center > mids[i]!) { to = i; break }
  return to
}

/** Перенос элемента списка с позиции from на позицию to. */
export function moveItem<T>(list: T[], from: number, to: number): T[] {
  if (from === to || from < 0 || to < 0 || from >= list.length || to >= list.length) return list
  const out = [...list]
  const [x] = out.splice(from, 1)
  out.splice(to, 0, x!)
  return out
}

/** Сдвиг соседнего элемента i при переносе from → to: на высоту перетаскиваемого (вверх или вниз), иначе 0. */
export function shiftFor(i: number, from: number, to: number, size: number): number {
  if (i === from) return 0
  if (from < to && i > from && i <= to) return -size
  if (from > to && i >= to && i < from) return size
  return 0
}

interface Active {
  from: number
  startY: number
  startScroll: number
  rects: { top: number; height: number }[]
  size: number
  lastY: number
  pointerId: number
}

interface DragView { id: string; dy: number; to: number; from: number; size: number }

function scrollTop(): number { return window.scrollY || document.documentElement.scrollTop || 0 }

/**
 * Перетаскивание элементов списка за «ручку». Возвращает порядок для показа (с учётом переноса,
 * пока сохранение идёт), стили элементов и свойства ручки.
 * onCommit вызывается один раз при отпускании, если порядок изменился.
 */
export function useDragSort(ids: string[], enabled: boolean, onCommit: (next: string[]) => Promise<unknown> | void) {
  const els = useRef(new Map<string, HTMLElement>())
  const active = useRef<Active | null>(null)
  const raf = useRef(0)
  const [view, setView] = useState<DragView | null>(null)
  const [pending, setPending] = useState<string[] | null>(null)
  const order = pending && pending.length === ids.length && pending.every((x) => ids.includes(x)) ? pending : ids

  const setEl = useCallback((id: string) => (el: HTMLElement | null) => {
    if (el) els.current.set(id, el); else els.current.delete(id)
  }, [])

  const update = useCallback(() => {
    const a = active.current
    if (!a) return
    const dy = a.lastY - a.startY + (scrollTop() - a.startScroll)
    const mids = a.rects.map((r) => r.top + r.height / 2)
    const center = mids[a.from]! + dy
    const to = targetIndex(mids, a.from, center)
    setView((v) => (v ? { ...v, dy, to } : v))
  }, [])

  const stop = useCallback(() => { cancelAnimationFrame(raf.current); active.current = null }, [])
  useEffect(() => stop, [stop])
  useEffect(() => { if (!enabled) { stop(); setView(null) } }, [enabled, stop])

  const tick = useCallback(() => {
    const a = active.current
    if (!a) return
    const edge = 90
    if (a.lastY < edge) window.scrollBy(0, -14)
    else if (a.lastY > window.innerHeight - edge - 50) window.scrollBy(0, 14)
    update()
    raf.current = requestAnimationFrame(tick)
  }, [update])

  function start(id: string, e: ReactPointerEvent<HTMLElement>) {
    if (!enabled || active.current) return
    const from = order.indexOf(id)
    if (from < 0) return
    const sc = scrollTop()
    const rects = order.map((x) => {
      const r = els.current.get(x)?.getBoundingClientRect()
      return { top: (r?.top ?? 0) + sc, height: r?.height ?? 0 }
    })
    const first = rects[Math.min(from + 1, rects.length - 1)]!
    const me = rects[from]!
    const gap = rects.length > 1
      ? (from < rects.length - 1 ? first.top - (me.top + me.height) : me.top - (rects[from - 1]!.top + rects[from - 1]!.height))
      : 0
    e.currentTarget.setPointerCapture(e.pointerId)
    active.current = { from, startY: e.clientY, startScroll: sc, rects, size: me.height + Math.max(gap, 0), lastY: e.clientY, pointerId: e.pointerId }
    setView({ id, dy: 0, to: from, from, size: me.height + Math.max(gap, 0) })
    raf.current = requestAnimationFrame(tick)
  }

  function move(e: ReactPointerEvent<HTMLElement>) {
    const a = active.current
    if (!a || e.pointerId !== a.pointerId) return
    a.lastY = e.clientY
    update()
  }

  function finish(e: ReactPointerEvent<HTMLElement>, cancel: boolean) {
    const a = active.current
    if (!a || e.pointerId !== a.pointerId) return
    const dy = a.lastY - a.startY + (scrollTop() - a.startScroll)
    const mids = a.rects.map((r) => r.top + r.height / 2)
    const to = targetIndex(mids, a.from, mids[a.from]! + dy)
    const from = a.from
    stop()
    setView(null)
    if (cancel || to === from) return
    const next = moveItem(order, from, to)
    setPending(next)
    void Promise.resolve(onCommit(next)).finally(() => setPending(null))
  }

  /** Стиль элемента списка (сдвиг на время перетаскивания). */
  const itemStyle = (id: string, index: number): CSSProperties => {
    if (!view) return {}
    if (id === view.id) {
      return { transform: `translateY(${view.dy}px)`, zIndex: 20, position: 'relative', boxShadow: '0 6px 18px rgba(0,0,0,.45)', transition: 'none', opacity: .96 }
    }
    const s = shiftFor(index, view.from, view.to, view.size)
    return { transform: s ? `translateY(${s}px)` : undefined, transition: 'transform 140ms ease' }
  }

  const handleProps = (id: string) => ({
    onPointerDown: (e: ReactPointerEvent<HTMLElement>) => start(id, e),
    onPointerMove: move,
    onPointerUp: (e: ReactPointerEvent<HTMLElement>) => finish(e, false),
    onPointerCancel: (e: ReactPointerEvent<HTMLElement>) => finish(e, true),
    onContextMenu: (e: { preventDefault(): void }) => e.preventDefault(),
    style: { touchAction: 'none' as const },
  })

  return { order, setEl, itemStyle, handleProps, dragging: view?.id ?? null }
}
