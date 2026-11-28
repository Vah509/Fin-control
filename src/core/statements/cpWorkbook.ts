// XLSX файла контрагентов: листы «Выписка» (колонки: контрагент в выписке, опознанный, тег, имя нового, IBAN), «Справочник» и «Теги» (список для выбора).
import type { CoreContext } from '../context'
import { tagTree } from '../tags'
import { collectCounterpartyGroups, recognizeGroups, tagLabel, type CpFileRow } from './counterparties'
import type { ParsedStatement } from './types'

export const CP_SHEET = 'Выписка'
export const CP_DIRECTORY_SHEET = 'Справочник'
export const CP_TAGS_SHEET = 'Теги'
export const CP_HELP_SHEET = 'Инструкция'
const KIND_RU: Record<string, string> = { shop: 'магазин', person: 'человек', organization: 'организация', own_account: 'свой счёт' }

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const loadExcel = async (): Promise<any> => {
  try { const m: any = await import('exceljs'); return m.default ?? m } catch {
    throw new Error('Не удалось загрузить модуль Excel. Закройте приложение полностью и откройте снова (возможно, вышла новая версия)')
  }
}


/** Текст листа «Инструкция»: промпт для ИИ, которому владелец отдаёт этот файл вместе с исходной выпиской. */
export const CP_INSTRUCTION: string[] = [
  'ИНСТРУКЦИЯ ДЛЯ ИИ (этот лист не менять и не удалять)',
  '',
  '1. ЗАДАЧА',
  'Нужно опознать контрагентов из банковской выписки. К сообщению приложены два файла: (1) этот XLSX, (2) исходная выписка банка (PDF или XLSX). Заполни лист «Выписка» этого файла и верни его.',
  '',
  '2. ЛИСТЫ',
  '«Выписка»: рабочий лист, одна строка на одного контрагента. «Справочник»: контрагенты, которые уже есть в базе (имя и тип), только читать. «Теги»: допустимые теги в виде «Группа › Тег», только читать.',
  '',
  '3. КОЛОНКИ ЛИСТА «ВЫПИСКА»',
  'A «Контрагент в выписке»: как написано в выписке. НЕ менять.',
  'B «Опознанный контрагент»: имя из листа «Справочник», символ в символ. Пусто, если подходящего контрагента в справочнике нет.',
  'C «Тег»: значение из листа «Теги», точно как написано. Заполняй только если уверен, иначе оставь пустым.',
  'D «Имя нового контрагента»: для тех, кого нет в справочнике. Короткое понятное имя (бренд, организация или человек) без города, адреса и номера точки.',
  'E «IBAN (служебное, не менять)»: не менять.',
  'F «Примеры из выписки»: до трёх операций (дата · сумма · описание), только для справки, чтобы понять, что это за контрагент. НЕ менять.',
  '',
  '4. ПРАВИЛА ЗАПОЛНЕНИЯ',
  '— Строки, где колонка B уже заполнена, не трогай.',
  '— Для каждой пустой строки сначала ищи контрагента в листе «Справочник». Нашёл: впиши его имя в B. Не нашёл: впиши имя в D, колонку B оставь пустой. В одной строке заполняется только B или только D.',
  '— Мелкие различия не делают контрагента новым. Считай одним контрагентом названия, которые отличаются регистром, диакритикой, городом или районом после запятой, номером или кодом точки. Пример: «LIDL», «Lidl dakuje 165», «LIDL Bratislava, Ruzinov» это один «Lidl», если он есть в справочнике.',
  '— Разные люди с одинаковой фамилией («Довженко А.» и «Довженко В.») это разные контрагенты. Сомневаешься: не объединяй, впиши имя в D.',
  '— Колонку «Тег» у строк, где контрагент опознан, оставляй пустой: тег подтянется из справочника сам. Тег указывай только новым контрагентам и только если уверен.',
  '— Не добавляй, не удаляй и не переставляй строки и колонки. Не меняй заголовки, названия листов, выпадающие списки и имя файла.',
  '— Не выдумывай. Используй только этот файл и выписку. Номера карт и счетов в ответ не выводи.',
  '',
  '5. ЧТО ВЕРНУТЬ',
  'Один файл: заполненный XLSX с тем же именем. В тексте ответа максимум две строки: сколько строк заполнено и какие оставлены пустыми.',
  '',
  '6. ПРИМЕР',
  'До: A = «LIDL Bratislava, Ruzinov», B пусто, D пусто. В справочнике есть «Lidl». После: B = «Lidl», D пусто.',
  'До: A = «Zepen House Nivy, Ruzinov», B пусто. В справочнике такого нет. После: B пусто, D = «Zepen House».',
]

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
  const help = wb.addWorksheet(CP_HELP_SHEET)
  help.columns = [{ width: 110 }]
  CP_INSTRUCTION.forEach((t, i) => { const r = help.addRow([t]); r.alignment = { wrapText: true, vertical: 'top' }; if (i === 0 || /^\d\. /.test(t)) r.font = { bold: true } })
  const ws = wb.addWorksheet(CP_SHEET)
  ws.columns = [
    { header: 'Контрагент в выписке', width: 46 }, { header: 'Опознанный контрагент', width: 40 }, { header: 'Тег', width: 44 },
    { header: 'Имя нового контрагента', width: 30 }, { header: 'IBAN (служебное, не менять)', width: 28 }, { header: 'Примеры из выписки (справка, не менять)', width: 90 },
  ]
  groups.forEach((g, i) => ws.addRow([g.text, found[i]?.name ?? '', (found[i]?.defaultTagId && labelById.get(found[i]!.defaultTagId!)) || '', '', g.iban ?? '', g.samples.join(' | ')]))
  const dir = wb.addWorksheet(CP_DIRECTORY_SHEET)
  dir.columns = [{ header: 'Имя', width: 40 }, { header: 'Тип', width: 16 }]
  for (const c of cps) dir.addRow([c.name, KIND_RU[c.kind] ?? c.kind])
  const tg = wb.addWorksheet(CP_TAGS_SHEET)
  tg.columns = [{ header: 'Группа › Тег', width: 44 }]
  for (const l of labels) tg.addRow([l])
  for (const w of [ws, dir, tg]) { w.getRow(1).font = { bold: true }; w.views = [{ state: 'frozen', ySplit: 1 }] }
  // Телефон: крупнее строки и шрифт, чтобы выпадающий список было легче нажать.
  for (let r = 2; r <= groups.length + 1; r++) { const row = ws.getRow(r); row.height = 36; row.font = { size: 13 }; row.alignment = { vertical: 'middle' } }
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
