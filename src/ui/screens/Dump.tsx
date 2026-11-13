import { useState } from 'react'
import { countRows, exportDump, mergeDump, parseDump } from '../../core'
import type { DataDump } from '../../data/storage'
import { ENTITY_NAMES } from '../../data/types'
import { useApp } from '../app'
import { errorText, todayLocal } from '../format'
import { BackButton, Notice, Screen } from '../parts'

const ENTITY_LABELS: Record<string, string> = {
  appSettings: 'настройки', planTypes: 'виды плановости', countries: 'страны', currencies: 'валюты',
  institutions: 'учреждения', projects: 'проекты', accounts: 'счета', accountIdentifiers: 'признаки счетов',
  tagGroups: 'группы тегов', tags: 'теги', counterparties: 'контрагенты', counterpartyIdentifiers: 'признаки контрагентов',
  transactions: 'операции', checkpoints: 'контрольные точки', periodLocks: 'закрытия периодов', fxRates: 'курсы',
  fxSourcePriorities: 'приоритеты курсов',
}

function download(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }))
  const a = document.createElement('a')
  a.href = url; a.download = name
  document.body.appendChild(a); a.click(); a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}

export function DumpScreen() {
  const { ctx, bump } = useApp()
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null)
  const [loaded, setLoaded] = useState<{ dump: DataDump; fileName: string } | null>(null)

  async function doExport(share: boolean) {
    setBusy(true); setMsg(null)
    try {
      const dump = await exportDump(ctx)
      const text = JSON.stringify(dump)
      const name = `fin-control-${todayLocal()}.json`
      const file = new File([text], name, { type: 'application/json' })
      if (share && navigator.canShare?.({ files: [file] })) {
        try { await navigator.share({ files: [file], title: name }) } catch (e) {
          if ((e as Error).name === 'AbortError') { setMsg({ kind: 'ok', text: 'Отправка отменена. Файл создан, повторите при необходимости.' }); return }
          download(name, text)
        }
      } else {
        download(name, text)
      }
      setMsg({ kind: 'ok', text: `Выгружено записей: ${countRows(dump)}.` })
    } catch (e) { setMsg({ kind: 'error', text: errorText(e) }) } finally { setBusy(false) }
  }

  async function pick(file: File | undefined) {
    setMsg(null); setLoaded(null)
    if (!file) return
    try { setLoaded({ dump: parseDump(await file.text()), fileName: file.name }) } catch (e) { setMsg({ kind: 'error', text: errorText(e) }) }
  }

  async function doMerge() {
    if (!loaded) return
    if (!window.confirm('Слить данные из файла в базу? Записи с теми же id будут заменены, ничего не удаляется.')) return
    setBusy(true); setMsg(null)
    try {
      const r = await mergeDump(ctx, loaded.dump)
      setMsg({ kind: 'ok', text: `Слито записей: ${r.rows}.` })
      setLoaded(null); bump()
    } catch (e) { setMsg({ kind: 'error', text: errorText(e) }) } finally { setBusy(false) }
  }

  return (
    <Screen title="Выгрузка и загрузка" back={<BackButton to="more" label="Прочее" />}>
      {!ctx.actor.isOwner && <Notice>Выгрузка и загрузка доступны только владельцу.</Notice>}
      <div className="card">
        <h2>Выгрузка</h2>
        <p className="muted">Один JSON со всеми данными. Файл не зашифрован: храните его там, где храните личные документы.</p>
        <div className="actions">
          <button className="btn primary" disabled={busy || !ctx.actor.isOwner} onClick={() => doExport(true)}>Поделиться файлом</button>
          <button className="btn" disabled={busy || !ctx.actor.isOwner} onClick={() => doExport(false)}>Скачать</button>
        </div>
      </div>
      <div className="card">
        <h2>Загрузка</h2>
        <p className="muted">Слияние: записи из файла добавляются или заменяют записи с тем же id. Ничего не удаляется. При закрытых периодах слияние запрещено.</p>
        <input type="file" accept="application/json,.json" disabled={busy || !ctx.actor.isOwner} onChange={(e) => pick(e.target.files?.[0])} />
        {loaded && (
          <div className="facts">
            <p><b>{loaded.fileName}</b>, записей: {countRows(loaded.dump)}</p>
            <ul className="plain">
              {ENTITY_NAMES.filter((n) => loaded.dump.data[n]?.length).map((n) => (
                <li key={n}><span>{ENTITY_LABELS[n] ?? n}</span><b>{loaded.dump.data[n]!.length}</b></li>
              ))}
            </ul>
            <button className="btn primary" disabled={busy} onClick={doMerge}>{busy ? 'Сливаем…' : 'Слить в базу'}</button>
          </div>
        )}
      </div>
      {msg && <div className={`box ${msg.kind}`} role={msg.kind === 'error' ? 'alert' : 'status'}>{msg.text}</div>}
    </Screen>
  )
}
