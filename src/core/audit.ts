import type { Json, NewAuditEntry, Transaction } from '../data/types'
import type { CoreContext } from './context'

export function auditEntry(
  ctx: CoreContext, action: string,
  o: { tableName?: string; recordId?: string; oldData?: Json | null; newData?: Json | null; details?: Json | null } = {},
): NewAuditEntry {
  return {
    at: ctx.now().toISOString(), userId: ctx.actor.userId, action,
    tableName: o.tableName ?? null, recordId: o.recordId ?? null,
    oldData: o.oldData ?? null, newData: o.newData ?? null, details: o.details ?? null,
  }
}

/** Запись для журнала без поля raw (там персональные данные). */
export function txForAudit(t: Transaction): Json {
  const { raw: _raw, ...rest } = t
  return rest as unknown as Json
}
