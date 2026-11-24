// XLSX файла контрагентов: листы «Выписка» (колонки: контрагент в выписке, опознанный, тег, имя нового, IBAN), «Справочник» и «Теги» (список для выбора).
import type { CoreContext } from '../context'
import { tagTree } from '../tags'
import { collectCounterpartyGroups, recognizeGroups, tagLabel, type CpFileRow } from './counterparties'
import type { ParsedStatement } from './types'

export const CP_SHEET = 'Выписка'
export const CP_DIRECTORY_SHEET = 'Справочник'
export const CP_TAGS_SHEET = 'Теги'
const KIND_RU: Record<string, string> = { shop: 'магазин', person: 'человек', organization: 'организация', own_account: 'свой счёт' }

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const loadExcel = async (): Promise<any> => {
  try { const m: any = await import('exceljs'); return m.default ?? m } catch {
    throw new Error('Не удалось загрузить модуль Excel. Закройте приложение полностью и откройте снова (возможно, вышла новая версия)')
  }
}

/** Выгрузка: читает справочник и опознаёт контрагентов на конец периода выписки. */
export async function buildCounterpartyWorkbook(ctx: CoreContext, st: ParsedStatement): Promise<Uint8Array> {
  const ExcelJS = await loadExcel()
  const groups = collectCounterpartyGroups(st).sort((a, b) => a.text.localeCompare(b.text, 'sk', { sensitivity: 'base', numeric: true }))
  const found = await recognizeGroups(ctx, groups)
  const cps = [...(await ctx.storage.list('counterparties'))].sort((a, b) => a.name.localeCompare(b.name, 'ru'))
  const tree = tagTree(await ctx.storage.list('tagGroups'), await ctx.storage.list('tags'))
  const labels: string[] = []
  const labelById = new Map<string, string>()
  for (const { group, tags } of tree) for (const t of tags) {
    labelById.set(t.id, tagLabel(group.name, t.name))
    if (!t.archivedAt) labels.push(tagLabel(group.name, t.name))
  }

  const wb = new ExcelJS.Workbook()
  const ws = wb.addWorksheet(CP_SHEET)
  ws.columns = [
    { header: 'Контрагент в выписке', width: 46 }, { header: 'Опознанный контрагент', width: 34 }, { header: 'Тег', width: 34 },
    { header: 'Имя нового контрагента', width: 30 }, { header: 'IBAN (служебное, не менять)', width: 28 },
  ]
  groups.forEach((g, i) => ws.addRow([g.text, found[i]?.name ?? '', (found[i]?.defaultTagId && labelById.get(found[i]!.defaultTagId!)) || '', '', g.iban ?? '']))
  const dir = wb.addWorksheet(CP_DIRECTORY_SHEET)
  dir.columns = [{ header: 'Имя', width: 40 }, { header: 'Тип', width: 16 }]
  for (const c of cps) dir.addRow([c.name, KIND_RU[c.kind] ?? c.kind])
  const tg = wb.addWorksheet(CP_TAGS_SHEET)
  tg.columns = [{ header: 'Группа › Тег', width: 44 }]
  for (const l of labels) tg.addRow([l])
  for (const w of [ws, dir, tg]) { w.getRow(1).font = { bold: true }; w.views = [{ state: 'frozen', ySplit: 1 }] }
  if (cps.length) {
    for (let r = 2; r <= groups.length + 1; r++) {
      ws.getCell(r, 2).dataValidation = { type: 'list', allowBlank: true, showErrorMessage: false, formulae: [`'${CP_DIRECTORY_SHEET}'!$A$2:$A$${cps.length + 1}`] }
    }
  }
  if (labels.length) {
    for (let r = 2; r <= groups.length + 1; r++) {
      ws.getCell(r, 3).dataValidation = { type: 'list', allowBlank: true, showErrorMessage: false, formulae: [`'${CP_TAGS_SHEET}'!$A$2:$A$${labels.length + 1}`] }
    }
  }
  return new Uint8Array((await wb.xlsx.writeBuffer()) as ArrayBuffer)
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function cellText(v: any): string {
  if (v == null) return ''
  if (typeof v === 'object') {
    if (Array.isArray(v.richText)) return v.richText.map((t: { text: string }) => t.text).join('').trim()
    if ('result' in v) return cellText(v.result)
    if ('text' in v) return cellText(v.text)
    return ''
  }
  return String(v).trim()
}

/** Чтение файла после правок владельца. Пустые строки пропускаются. */
export async function readCounterpartyWorkbook(data: ArrayBuffer | Uint8Array): Promise<CpFileRow[]> {
  const ExcelJS = await loadExcel()
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.load(data)
  const ws = wb.getWorksheet(CP_SHEET)
  if (!ws) throw new Error(`COUNTERPARTY_FILE_INVALID: нет листа «${CP_SHEET}» (это не файл контрагентов)`)
  const col = new Map<string, number>()
  ws.getRow(1).eachCell((c: { value: unknown }, n: number) => col.set(cellText(c.value), n))
  const cName = col.get('Имя нового контрагента') ?? 3, cIban = col.get('IBAN (служебное, не менять)') ?? 4, cTag = col.get('Тег') ?? 0   // старые файлы без колонки «Тег» читаются как раньше
  const out: CpFileRow[] = []
  ws.eachRow((row: { number: number; getCell: (n: number) => { value: unknown } }, n: number) => {
    if (n === 1) return
    const text = cellText(row.getCell(1).value)
    if (!text) return
    out.push({ row: n, text, resolved: cellText(row.getCell(2).value), newName: cellText(row.getCell(cName).value), iban: cellText(row.getCell(cIban).value) || null, tag: cTag ? cellText(row.getCell(cTag).value) : '' })
  })
  return out
}
