// Файл контрагентов (шаг 1 работы с выпиской): уникальные контрагенты из выписки, опознание по справочнику,
// загрузка правок владельца. Всё или ничего: при любой ошибке в файле ничего не записывается.
import type { Counterparty, CounterpartyIdentifier } from '../../data/types'
import { auditEntry } from '../audit'
import type { CoreContext } from '../context'
import { fail } from '../errors'
import { normalizeIdentifier } from '../identifiers'
import { makeKey } from '../keys'
import type { Tag, TagGroup } from '../../data/types'
import { addDays } from '../time'
import type { ParsedStatement } from './types'

/** Строка колонки 1 файла контрагентов. */
export interface CpGroup {
  /** «Контрагент в выписке»: торговая точка, имя по SEPA или заголовок операции */
  text: string
  /** SEPA: IBAN контрагента без пробелов */
  iban: string | null
  kind: 'card' | 'sepa' | 'other'
  rows: number
}

/** Строка файла, прочитанная обратно. row = номер строки в Excel (для сообщений об ошибках). */
export interface CpFileRow { row: number; text: string; resolved: string; newName: string; iban: string | null; /** «Группа › Тег» или просто имя тега; пусто = не менять */ tag?: string }

export interface CpFileResult { created: number; identifiersAdded: number; reassigned: number; rowsLinked: number; tagsSet: number }

/** Подпись тега в файле: «Группа › Тег». */
export const tagLabel = (group: string, tag: string) => `${group} › ${tag}`

const nameKey = (s: string) => s.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase()
const collapse = (s: string) => s.normalize('NFKC').trim().replace(/\s+/g, ' ')
const ibanKey = (iban: string) => normalizeIdentifier('account_number', iban)
const activeOn = (i: { validFrom: string; validTo: string | null }, d: string) => i.validFrom <= d && d <= (i.validTo ?? '9999-12-31')

/** Ключ группы контрагента (общий для файла контрагентов и файла операций). */
export function groupKeyOf(c: { name: string; iban: string | null }): string {
  const text = collapse(c.name)
  return c.iban ? `iban:${ibanKey(c.iban)}` : `name:${nameKey(text)}`
}

/** Уникальные контрагенты по всем счетам выписки (порядок первого появления). */
export function collectCounterpartyGroups(st: ParsedStatement): CpGroup[] {
  const map = new Map<string, CpGroup>()
  for (const acc of st.accounts) {
    for (const r of acc.rows) {
      const c = r.counterparty
      const text = collapse(c.name)
      if (!text) continue
      const key = groupKeyOf(c)
      const g = map.get(key)
      if (g) g.rows++
      else map.set(key, { text, iban: c.iban ? ibanKey(c.iban).toUpperCase() : null, kind: c.kind, rows: 1 })
    }
  }
  return [...map.values()]
}

/** Опознание по справочнику (по умолчанию на сегодня: признаки контрагентов не привязаны к дате выписки). Сначала IBAN, затем название. null = не опознан. */
export async function recognizeGroups(ctx: CoreContext, groups: CpGroup[], date = ctx.now().toISOString().slice(0, 10)): Promise<(Counterparty | null)[]> {
  const cps = await ctx.storage.list('counterparties')
  const ids = (await ctx.storage.list('counterpartyIdentifiers')).filter((i) => activeOn(i, date))
  const byId = new Map(cps.map((c) => [c.id, c]))
  const byName = new Map<string, string>()
  for (const i of ids) if (i.kind === 'statement_name' && i.value) byName.set(nameKey(i.value), i.counterpartyId)
  const byHash = new Map<string, string>()
  for (const i of ids) if (i.kind === 'account_number' && i.valueHash) byHash.set(i.valueHash, i.counterpartyId)
  const c = ctx.crypto ?? null   // без ключей шифрования (пока так в приложении) опознание только по названию
  const out: (Counterparty | null)[] = []
  for (const g of groups) {
    let id: string | undefined
    if (g.iban && c) id = byHash.get(await c.hmacHex(`account_number:${ibanKey(g.iban)}`))
    id ??= byName.get(nameKey(g.text))
    out.push(id ? byId.get(id) ?? null : null)
  }
  return out
}

export interface CpStatus { total: number; recognized: number; unrecognized: CpGroup[] }

/** Сколько контрагентов в выписке и сколько из них опознано по справочнику (до скачивания файла контрагентов). */
export async function counterpartyStatus(ctx: CoreContext, st: ParsedStatement): Promise<CpStatus> {
  const groups = collectCounterpartyGroups(st)
  const found = await recognizeGroups(ctx, groups)
  const unrecognized = groups.filter((_, i) => !found[i])
  return { total: groups.length, recognized: groups.length - unrecognized.length, unrecognized }
}

/**
 * Загрузка файла контрагентов. Правила:
 * колонка 2 заполнена и имя есть в справочнике: признаки (название, IBAN) добавляются этому контрагенту;
 * заполнена, но имени нет: файл не принимается (номера строк в сообщении);
 * пусто: новый контрагент (имя из колонки 3, иначе из колонки 1, тип «организация»); одинаковые новые имена сводятся к одному.
 */
export async function applyCounterpartyFile(ctx: CoreContext, rows: CpFileRow[]): Promise<CpFileResult> {
  const today = ctx.now().toISOString().slice(0, 10)
  const cps = await ctx.storage.list('counterparties')
  const idents = (await ctx.storage.list('counterpartyIdentifiers')).filter((i) => activeOn(i, today))
  const byName = new Map<string, Counterparty[]>()
  for (const c of cps) byName.set(nameKey(c.name), [...(byName.get(nameKey(c.name)) ?? []), c])

  const [tagGroups, allTags] = await Promise.all([ctx.storage.list('tagGroups'), ctx.storage.list('tags')])
  const resolveTag = (label: string): { id: string } | { error: string } => {
    const parts = label.split(/\s*[›>]\s*/)
    let cand: Tag[]
    if (parts.length >= 2) {
      const g: TagGroup | undefined = tagGroups.find((x) => nameKey(x.name) === nameKey(parts[0]!))
      cand = g ? allTags.filter((t) => t.groupId === g.id && nameKey(t.name) === nameKey(parts.slice(1).join(' › '))) : []
    } else cand = allTags.filter((t) => nameKey(t.name) === nameKey(label))
    const live = cand.filter((t) => !t.archivedAt)
    if (live.length === 1) return { id: live[0]!.id }
    if (live.length > 1) return { error: `тег «${label}» есть в нескольких группах: выберите из списка «Группа › Тег»` }
    return { error: cand.length ? `тег «${label}» в архиве` : `тега «${label}» нет в списке (лист «Теги»)` }
  }
  const tagWanted = new Map<string, { tagId: string; row: number }>()
  const wantTag = (r: CpFileRow, cpId: string) => {
    const label = collapse(r.tag ?? '')
    if (!label) return
    const res = resolveTag(label)
    if ('error' in res) { errors.push({ row: r.row, message: res.error }); return }
    const prev = tagWanted.get(cpId)
    if (prev && prev.tagId !== res.id) errors.push({ row: r.row, message: `у одного контрагента разные теги (строки ${prev.row} и ${r.row})` })
    else tagWanted.set(cpId, { tagId: res.id, row: r.row })
  }

  const errors: { row: number; message: string }[] = []
  const newCps = new Map<string, Counterparty>()
  const taken = new Set(cps.map((c) => c.key))
  const links: { row: CpFileRow; cpId: string }[] = []

  for (const r of rows) {
    const text = collapse(r.text)
    if (!text) continue
    const resolved = collapse(r.resolved)
    if (resolved) {
      const hit = byName.get(nameKey(resolved)) ?? []
      if (hit.length === 0) errors.push({ row: r.row, message: `«${resolved}» нет в справочнике (опечатка?)` })
      else if (hit.length > 1) errors.push({ row: r.row, message: `в справочнике несколько контрагентов «${resolved}»` })
      else { links.push({ row: r, cpId: hit[0]!.id }); wantTag(r, hit[0]!.id) }
      continue
    }
    const name = collapse(r.newName) || text
    if (byName.has(nameKey(name))) {
      errors.push({ row: r.row, message: `имя «${name}» уже есть в справочнике: впишите его во 2-ю колонку` })
      continue
    }
    let c = newCps.get(nameKey(name))
    if (!c) {
      const key = makeKey(name, taken, 'counterparty'); taken.add(key)
      c = { id: ctx.newId(), key, name, kind: 'organization', accountId: null, defaultTagId: null, defaultPlanType: null }
      newCps.set(nameKey(name), c)
    }
    links.push({ row: r, cpId: c.id })
    wantTag(r, c.id)
  }
  if (errors.length) {
    const shown = errors.slice(0, 5).map((e) => `строка ${e.row}: ${e.message}`).join('; ')
    fail('COUNTERPARTY_FILE_INVALID', shown + (errors.length > 5 ? ` (и ещё ${errors.length - 5})` : '') + '. Ничего не записано.', { errors })
  }

  const crypto = ctx.crypto ?? null   // без ключей IBAN-признаки не создаются, остаются названия
  const put: CounterpartyIdentifier[] = []
  const seen = new Set<string>()
  let added = 0, reassigned = 0
  const place = (cpId: string, kind: 'statement_name' | 'account_number', matchKey: string, row: Omit<CounterpartyIdentifier, 'id' | 'counterpartyId' | 'kind' | 'validFrom' | 'validTo'>, find: (i: CounterpartyIdentifier) => boolean) => {
    const k = `${kind}:${matchKey}`
    if (seen.has(k)) return
    seen.add(k)
    const old = idents.find((i) => i.kind === kind && find(i))
    if (old?.counterpartyId === cpId) return
    if (old) {
      reassigned++
      // тот же день: признак просто переходит к другому контрагенту; иначе старый закрывается вчера
      if (old.validFrom >= today) { put.push({ ...old, counterpartyId: cpId }); return }
      put.push({ ...old, validTo: addDays(today, -1) })
    }
    put.push({ id: ctx.newId(), counterpartyId: cpId, kind, ...row, validFrom: today, validTo: null })
    added++
  }
  for (const l of links) {
    const text = collapse(l.row.text)
    place(l.cpId, 'statement_name', nameKey(text), { value: text, valueHash: null, valueEnc: null, last4: null }, (i) => !!i.value && nameKey(i.value) === nameKey(text))
    if (l.row.iban && crypto) {
      const norm = ibanKey(l.row.iban)
      const hash = await crypto.hmacHex(`account_number:${norm}`)
      place(l.cpId, 'account_number', hash, { value: null, valueHash: hash, valueEnc: await crypto.encrypt(norm), last4: norm.slice(-4) }, (i) => i.valueHash === hash)
    }
  }

  const updated: Counterparty[] = []
  let tagsSet = 0
  for (const [cpId, w] of tagWanted) {
    const fresh = [...newCps.values()].find((c) => c.id === cpId)
    if (fresh) { fresh.defaultTagId = w.tagId; tagsSet++; continue }
    const old = cps.find((c) => c.id === cpId)
    if (old && old.defaultTagId !== w.tagId) { updated.push({ ...old, defaultTagId: w.tagId }); tagsSet++ }
  }
  const created = [...newCps.values()]
  if (created.length || put.length || updated.length) {
    await ctx.storage.applyBatch({
      put: { counterparties: [...created, ...updated], counterpartyIdentifiers: put },
      audit: [auditEntry(ctx, 'counterparty_file_loaded', { tableName: 'counterparties', details: { created: created.length, identifiersAdded: added, reassigned, rows: links.length, tagsSet } })],
    })
  }
  return { created: created.length, identifiersAdded: added, reassigned, rowsLinked: links.length, tagsSet }
}
