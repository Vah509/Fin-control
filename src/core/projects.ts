// Разделы (проекты): группы счетов для показа и фильтра. Закрытие периодов к разделам не привязано.
// Здесь же порядок разделов и счетов и перенос счёта между разделами.
import type { Account, Json, Project } from '../data/types'
import { auditEntry } from './audit'
import type { CoreContext } from './context'
import { fail } from './errors'
import { makeKey } from './keys'

function needOwner(ctx: CoreContext) {
  if (!ctx.actor.isOwner) fail('FORBIDDEN', 'менять разделы и порядок может только владелец')
}
const sorted = <T extends { sortOrder: number; key: string }>(xs: T[]) =>
  [...xs].sort((a, b) => a.sortOrder - b.sortOrder || a.key.localeCompare(b.key))

export async function createProject(ctx: CoreContext, input: { name: string; key?: string; id?: string; appearance?: Json }): Promise<Project> {
  needOwner(ctx)
  const name = input.name.trim()
  if (!name) fail('INVALID_FIELD', 'нужно название раздела')
  const all = await ctx.storage.list('projects')
  const key = input.key ?? makeKey(name, all.map((p) => p.key), 'razdel')
  if (!/^[a-z0-9_-]+$/.test(key)) fail('INVALID_FIELD', `ключ раздела: только a-z, 0-9, _ и -: ${key}`)
  if (all.some((p) => p.key === key)) fail('DUPLICATE_KEY', `раздел с ключом ${key} уже есть`)
  const project: Project = {
    id: input.id ?? ctx.newId(), key, name, appearance: input.appearance ?? {},
    sortOrder: all.reduce((m, p) => Math.max(m, p.sortOrder), -1) + 1,
  }
  await ctx.storage.applyBatch({
    put: { projects: [project] },
    audit: [auditEntry(ctx, 'project_created', { tableName: 'projects', recordId: project.id, newData: project as never })],
  })
  return project
}

export async function updateProject(ctx: CoreContext, id: string, patch: { name?: string; appearance?: Json }): Promise<Project> {
  needOwner(ctx)
  const old = (await ctx.storage.list('projects')).find((p) => p.id === id) ?? fail('NOT_FOUND', 'раздел не найден')
  const name = (patch.name ?? old.name).trim()
  if (!name) fail('INVALID_FIELD', 'нужно название раздела')
  const next: Project = { ...old, name, appearance: patch.appearance ?? old.appearance }
  await ctx.storage.applyBatch({
    put: { projects: [next] },
    audit: [auditEntry(ctx, 'project_updated', { tableName: 'projects', recordId: id, oldData: old as never, newData: next as never })],
  })
  return next
}

/** Порядок разделов: список id сверху вниз, должен содержать каждый раздел ровно один раз. */
export async function reorderProjects(ctx: CoreContext, orderedIds: string[]): Promise<void> {
  needOwner(ctx)
  const all = await ctx.storage.list('projects')
  if (orderedIds.length !== all.length || new Set(orderedIds).size !== all.length || !all.every((p) => orderedIds.includes(p.id))) {
    fail('INVALID_FIELD', 'в порядке должны быть все разделы по одному разу')
  }
  const byId = new Map(all.map((p) => [p.id, p]))
  const changed = orderedIds.map((id, i) => ({ ...byId.get(id)!, sortOrder: i })).filter((p) => p.sortOrder !== byId.get(p.id)!.sortOrder)
  if (!changed.length) return
  await ctx.storage.applyBatch({
    put: { projects: changed },
    audit: [auditEntry(ctx, 'projects_reordered', { tableName: 'projects', details: { order: orderedIds } })],
  })
}

/** Порядок счетов внутри раздела: список id сверху вниз, все счета раздела по одному разу (архивные тоже). */
export async function reorderAccounts(ctx: CoreContext, projectId: string, orderedIds: string[]): Promise<void> {
  needOwner(ctx)
  const inProject = (await ctx.storage.list('accounts')).filter((a) => a.projectId === projectId)
  if (orderedIds.length !== inProject.length || new Set(orderedIds).size !== inProject.length || !inProject.every((a) => orderedIds.includes(a.id))) {
    fail('INVALID_FIELD', 'в порядке должны быть все счета раздела по одному разу')
  }
  const byId = new Map(inProject.map((a) => [a.id, a]))
  const changed = orderedIds.map((id, i) => ({ ...byId.get(id)!, sortOrder: i })).filter((a) => a.sortOrder !== byId.get(a.id)!.sortOrder)
  if (!changed.length) return
  await ctx.storage.applyBatch({
    put: { accounts: changed },
    audit: [auditEntry(ctx, 'accounts_reordered', { tableName: 'accounts', details: { projectId, order: orderedIds } })],
  })
}

/** Перенос счёта в другой раздел (в конец или на позицию index). Закрытие общее, поэтому ограничений нет. */
export async function moveAccount(ctx: CoreContext, accountId: string, projectId: string, index?: number): Promise<Account> {
  needOwner(ctx)
  const [accounts, projects] = await Promise.all([ctx.storage.list('accounts'), ctx.storage.list('projects')])
  const acc = accounts.find((a) => a.id === accountId) ?? fail('NOT_FOUND', 'счёт не найден')
  if (!projects.some((p) => p.id === projectId)) fail('NOT_FOUND', 'раздел не найден')
  const target = sorted(accounts.filter((a) => a.projectId === projectId && a.id !== accountId))
  const pos = index === undefined ? target.length : Math.max(0, Math.min(index, target.length))
  target.splice(pos, 0, acc)
  const puts = target.map((a, i) => ({ ...a, projectId, sortOrder: i })).filter((a) => {
    const o = accounts.find((x) => x.id === a.id)!
    return o.projectId !== a.projectId || o.sortOrder !== a.sortOrder
  })
  if (!puts.length) return acc
  await ctx.storage.applyBatch({
    put: { accounts: puts },
    audit: [auditEntry(ctx, 'account_moved', {
      tableName: 'accounts', recordId: accountId, oldData: { projectId: acc.projectId }, newData: { projectId },
    })],
  })
  return puts.find((a) => a.id === accountId) ?? { ...acc, projectId }
}
