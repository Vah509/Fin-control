// Выгрузка и загрузка (слияние) файла данных. Формат один для всех хранилищ.
import { DUMP_FORMAT, type DataDump } from '../data/storage'
import { ENTITY_NAMES } from '../data/types'
import { auditEntry } from './audit'
import type { CoreContext } from './context'
import { fail } from './errors'

export async function exportDump(ctx: CoreContext): Promise<DataDump> {
  if (!ctx.actor.isOwner) fail('FORBIDDEN', 'выгрузку может делать только владелец')
  const dump = await ctx.storage.exportAll()
  await ctx.storage.applyBatch({ audit: [auditEntry(ctx, 'dump_exported', { details: { rows: countRows(dump) } })] })
  return dump
}

export const countRows = (d: DataDump) => ENTITY_NAMES.reduce((s, n) => s + (d.data[n]?.length ?? 0), 0)

/** Разбор текста файла. Проверяет только формат; содержимое проверяет база и ограничения таблиц. */
export function parseDump(text: string): DataDump {
  let v: unknown
  try { v = JSON.parse(text) } catch { return fail('INVALID_FIELD', 'файл не является JSON') }
  const d = v as Partial<DataDump> | null
  if (!d || d.format !== DUMP_FORMAT || d.version !== 1 || typeof d.data !== 'object' || d.data === null) {
    return fail('INVALID_FIELD', 'это не файл выгрузки Fin-control (формат или версия не совпадают)')
  }
  // Файлы, выгруженные до шага 4в, не знают про порядок и оформление разделов и про общее закрытие.
  const data = d.data as unknown as Record<string, Record<string, unknown>[] | undefined>
  if (Array.isArray(data['projects'])) data['projects'] = data['projects'].map((p, i) => ({ sortOrder: i, appearance: {}, ...p }))
  if (Array.isArray(data['periodLocks'])) data['periodLocks'] = data['periodLocks'].map((l) => ({ projectId: null, ...l }))
  return d as DataDump
}

/** Слияние: записи из файла добавляются или заменяют записи с тем же id (одним пакетом, всё или ничего).
 *  Ничего не удаляется. Пока есть закрытые периоды, слияние запрещено: оно могло бы обойти закрытие. */
export async function mergeDump(ctx: CoreContext, dump: DataDump): Promise<{ rows: number }> {
  if (!ctx.actor.isOwner) fail('FORBIDDEN', 'загрузку может делать только владелец')
  const locks = (await ctx.storage.listPeriodLocks()).filter((l) => l.status === 'active')
  if (locks.length) fail('PERIOD_LOCKED', 'есть закрытые периоды: слияние файла запрещено, чтобы не обойти закрытие')
  const put: Record<string, unknown[]> = {}
  for (const n of ENTITY_NAMES) if (dump.data[n]?.length) put[n] = dump.data[n]
  const rows = countRows(dump)
  await ctx.storage.applyBatch({
    put: put as never,
    audit: [auditEntry(ctx, 'dump_merged', { details: { rows, exportedAt: dump.exportedAt ?? null } })],
  })
  return { rows }
}
