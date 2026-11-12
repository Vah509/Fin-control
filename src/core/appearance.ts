// Оформление счёта и раздела: цвет и иконка. Хранится в поле appearance (json), клиент терпим к неизвестным значениям.
import type { AccountType, Json } from '../data/types'

export const COLORS = {
  blue: '#2563eb', green: '#16a34a', orange: '#ea580c', red: '#dc2626',
  purple: '#7c3aed', teal: '#0d9488', pink: '#db2777', gray: '#6b7280',
} as const
export type ColorKey = keyof typeof COLORS

export const ICONS = {
  bank: '🏦', card: '💳', wallet: '👛', cash: '💵', broker: '📈', person: '👤',
  firm: '🏢', savings: '🐷', home: '🏠', car: '🚗', travel: '✈️', star: '⭐',
} as const
export type IconKey = keyof typeof ICONS

export interface Appearance { color: ColorKey | null; icon: IconKey | null }

const TYPE_ICON: Record<AccountType, IconKey> = {
  bank: 'bank', wallet: 'wallet', broker: 'broker', cash: 'cash', person: 'person', firm: 'firm',
}
const isObj = (v: Json): v is { [k: string]: Json } => typeof v === 'object' && v !== null && !Array.isArray(v)

/** Читает оформление; незнакомые значения игнорируются. */
export function readAppearance(a: Json): Appearance {
  const o = isObj(a) ? a : {}
  const color = typeof o['color'] === 'string' && o['color'] in COLORS ? (o['color'] as ColorKey) : null
  const icon = typeof o['icon'] === 'string' && o['icon'] in ICONS ? (o['icon'] as IconKey) : null
  return { color, icon }
}

/** Записывает оформление, сохраняя чужие поля (версия, узор, seed и т.д.). */
export function writeAppearance(old: Json, next: Appearance): Json {
  const base = isObj(old) ? { ...old } : {}
  const out: { [k: string]: Json } = { ...base, v: 1 }
  if (next.color) out['color'] = next.color; else delete out['color']
  if (next.icon) out['icon'] = next.icon; else delete out['icon']
  return out
}

/** Цвет по умолчанию стабилен для счёта: берётся из id, чтобы список не был однотонным. */
export function defaultColor(id: string): ColorKey {
  const keys = Object.keys(COLORS) as ColorKey[]
  let h = 0
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) >>> 0
  return keys[h % keys.length]!
}

export function resolveAppearance(a: Json, id: string, type: AccountType): { color: ColorKey; icon: IconKey } {
  const r = readAppearance(a)
  return { color: r.color ?? defaultColor(id), icon: r.icon ?? TYPE_ICON[type] }
}
