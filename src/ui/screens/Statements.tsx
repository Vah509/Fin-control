// Экран «Выписки»: выбор PDF, разбор в памяти, сверка, файл контрагентов (выгрузка и загрузка правок).
import { useState } from 'react'
import { applyCounterpartyFile, buildCounterpartyWorkbook, extractPdfPages, parseSlspStatement, readCounterpartyWorkbook, reconcileAccount, type ParsedStatement } from '../../core/statements'
import { formatMinor } from '../../core'
import { useApp } from '../app'
import { dateRu, errorText } from '../format'
import { Notice, Screen } from '../parts'

const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'

async function saveFile(name: string, bytes: Uint8Array, type: string): Promise<void> {
  const file = new File([bytes as BlobPart], name, { type })
  if (navigator.canShare?.({ files: [file] })) {
    try { await navigator.share({ files: [file], title: name }); return } catch (e) { if ((e as Error).name === 'AbortError') return }
  }
  const url = URL.createObjectURL(file)
  const a = document.createElement('a')
  a.href = url; a.download = name
  document.body.appendChild(a); a.click(); a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}

interface Picked { name: string; bytes: Uint8Array }

export function StatementsScreen() {
  const { ctx, bump } = useApp()
  const [busy, setBusy] = useState(false)
  const [parsed, setParsed] = useState<{ st: ParsedStatement; name: string } | null>(null)
  const [pdf, setPdf] = useState<Picked | null>(null)
  const [xlsx, setXlsx] = useState<Picked | null>(null)
  const [msg, setMsg] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null)

  // Файл читается в память сразу при выборе (на Android иначе бывает «0 байт»); поле выбора не очищается.
  async function choose(file: File | undefined, set: (v: Picked | null) => void) {
    setMsg(null)
    if (!file) { set(null); return }
    try { set({ name: file.name, bytes: new Uint8Array(await file.arrayBuffer()) }) } catch (e) { set(null); setMsg({ kind: 'error', text: errorText(e) }) }
  }

  async function parsePdf() {
    if (!pdf) return
    setMsg(null); setParsed(null); setBusy(true)
    try {
      if (!pdf.bytes.length) throw new Error('Файл пустой (0 байт). Выберите его ещё раз, лучше из «Загрузки».')
      setParsed({ st: parseSlspStatement(await extractPdfPages(pdf.bytes.slice())), name: pdf.name })
    } catch (e) { setMsg({ kind: 'error', text: errorText(e) }) } finally { setBusy(false) }
  }

  async function exportCp() {
    if (!parsed) return
    setBusy(true); setMsg(null)
    try {
      const a = parsed.st.accounts[0]
      const name = `kontragenty_${a ? a.periodEnd.slice(0, 7) : 'vypis'}.xlsx`
      await saveFile(name, await buildCounterpartyWorkbook(ctx, parsed.st), XLSX)
      setMsg({ kind: 'ok', text: `Файл контрагентов создан: ${name}. Впишите имена во 2-ю колонку и загрузите обратно.` })
    } catch (e) { setMsg({ kind: 'error', text: errorText(e) }) } finally { setBusy(false) }
  }

  async function loadCp() {
    if (!xlsx) return
    setBusy(true); setMsg(null)
    try {
      const r = await applyCounterpartyFile(ctx, await readCounterpartyWorkbook(xlsx.bytes.slice()))
      bump()
      setMsg({ kind: 'ok', text: `Принято. Строк: ${r.rowsLinked}, новых контрагентов: ${r.created}, признаков добавлено: ${r.identifiersAdded}${r.reassigned ? `, переназначено: ${r.reassigned}` : ''}.` })
    } catch (e) { setMsg({ kind: 'error', text: errorText(e) }) } finally { setBusy(false) }
  }

  return (
    <Screen title="Выписки">
      <div className="card">
        <p>1. Выберите PDF выписки Slovenská sporiteľňa. Разбор идёт на телефоне, файл никуда не отправляется и не хранится.</p>
        <input type="file" accept="application/pdf,.pdf" disabled={busy} onChange={(e) => void choose(e.target.files?.[0], setPdf)} />
        {pdf && <p className="muted">Выбран: {pdf.name}</p>}
        <button className="btn primary" disabled={busy || !pdf} onClick={() => void parsePdf()}>Загрузить и разобрать</button>
      </div>
      {busy && <p className="muted">Подождите…</p>}
      {msg && <Notice kind={msg.kind === 'ok' ? 'ok' : 'warn'}>{msg.text}</Notice>}
      {parsed && parsed.st.accounts.map((a) => {
        const rec = reconcileAccount(a)
        const d = 2
        return (
          <div className="card" key={a.number}>
            <p><b>{a.title}</b> · …{a.key} · {a.currency}</p>
            <p className="muted">{dateRu(a.periodStart)} — {dateRu(a.periodEnd)}, операций: {a.rows.length}</p>
            <p>Остаток: {formatMinor(a.openingMinor, d)} → {formatMinor(a.closingMinor, d)}</p>
            {rec.ok
              ? <Notice kind="ok">Сверка сошлась до копейки.</Notice>
              : <Notice kind="warn">НЕ СОШЛОСЬ{rec.firstBadRow ? `: первая строка ${rec.firstBadRow}` : ''}. Строк с расхождением: {rec.badRows.length}.</Notice>}
          </div>
        )
      })}
      {parsed && (
        <div className="card">
          <p>2. Контрагенты. Скачайте файл, впишите во 2-ю колонку имена из справочника (или оставьте пусто для нового), затем загрузите обратно.</p>
          <button className="btn primary" disabled={busy} onClick={() => void exportCp()}>Скачать файл контрагентов</button>
        </div>
      )}
      <div className="card">
        <p>{parsed ? '3.' : '2.'} Загрузить правленый файл контрагентов (XLSX). Если в файле ошибка, ничего не записывается.</p>
        <input type="file" accept=".xlsx" disabled={busy} onChange={(e) => void choose(e.target.files?.[0], setXlsx)} />
        {xlsx && <p className="muted">Выбран: {xlsx.name}</p>}
        <button className="btn primary" disabled={busy || !xlsx} onClick={() => void loadCp()}>Загрузить файл контрагентов</button>
      </div>
    </Screen>
  )
}
