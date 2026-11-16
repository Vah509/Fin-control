// Загрузка ответа чата в задание и экран разбора (три раздела). Вся логика в ядре, здесь только показ и кнопки.
import { useState } from 'react'
import {
  addImportResponse, analyzeImport, loadImport, readReview, resetImportResponses, rollbackImport, saveImportDecisions,
  type ImportReview, type ReviewStatement,
} from '../../core'
import type { ImportDecisions, ImportJob } from '../../data/types'
import { useApp } from '../app'
import { useLoad } from '../hooks'
import { dateTimeRu, errorText, money } from '../format'
import { ErrorBox, Loading, Notice } from '../parts'

type Msg = { kind: 'ok' | 'error'; text: string } | null

export function ResponseLoader({ job, onChanged }: { job: ImportJob; onChanged: () => void }) {
  const { ctx } = useApp()
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<Msg>(null)
  async function submit(t: string) {
    setBusy(true); setMsg(null)
    try { const n = await addImportResponse(ctx, job.id, t); setText(''); setMsg({ kind: 'ok', text: `Принято файлов: ${n}` }); onChanged() }
    catch (e) { setMsg({ kind: 'error', text: errorText(e) }) } finally { setBusy(false) }
  }
  async function paste() {
    try { setText(await navigator.clipboard.readText()) } catch (e) { setMsg({ kind: 'error', text: errorText(e) }) }
  }
  return (
    <div className="card">
      <h2>Ответ чата</h2>
      <p className="muted">Вставьте JSON из чата (можно несколько частей подряд) или выберите файл. Второй ответ другого чата служит для сверки.</p>
      <textarea rows={4} value={text} onChange={(e) => setText(e.target.value)} placeholder="Вставьте JSON" />
      <div className="actions">
        <button className="btn" onClick={paste}>Вставить из буфера</button>
        <button className="btn primary" disabled={busy || !text.trim() || !ctx.actor.isOwner} onClick={() => submit(text)}>Принять</button>
      </div>
      <label className="btn">Выбрать файл
        <input type="file" accept=".json,.txt,application/json,text/plain" hidden onChange={async (e) => { const f = e.target.files?.[0]; if (f) await submit(await f.text()); e.target.value = '' }} />
      </label>
      {msg && <div className={`box ${msg.kind}`} role={msg.kind === 'error' ? 'alert' : 'status'}>{msg.text}</div>}
    </div>
  )
}

export function ReviewPanel({ job, onChanged }: { job: ImportJob; onChanged: () => void }) {
  const { ctx, ref, bump } = useApp()
  const rv = useLoad(() => analyzeImport(ctx, job.id), [job.id, job.updatedAt])
  const cps = useLoad(() => ctx.storage.list('counterparties'), [])
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<Msg>(null)
  const decisions = readReview(job).decisions

  async function change(fn: (d: ImportDecisions) => void) {
    const d: ImportDecisions = JSON.parse(JSON.stringify(decisions))
    fn(d)
    setBusy(true); setMsg(null)
    try { await saveImportDecisions(ctx, job.id, d); onChanged() } catch (e) { setMsg({ kind: 'error', text: errorText(e) }) } finally { setBusy(false) }
  }
  async function act(fn: () => Promise<string>) {
    setBusy(true); setMsg(null)
    try { setMsg({ kind: 'ok', text: await fn() }); bump(); onChanged() } catch (e) { setMsg({ kind: 'error', text: errorText(e) }) } finally { setBusy(false) }
  }

  if (rv.loading) return <Loading what="Проверка…" />
  if (rv.error) return <ErrorBox text={rv.error} onRetry={rv.reload} />
  const r: ImportReview | null = rv.data
  if (!r) return null
  const accName = (id: string | null) => ref.accounts.find((a) => a.id === id)?.name ?? '—'
  const m = (st: ReviewStatement, v: number) => money(v, st.decimals)
  const choices = ref.accounts.filter((a) => a.archivedAt === null && a.trackingMode === 'balance_and_movements')
  const readyRows = r.statements.filter((s) => s.accountState !== 'skipped' && s.accountId)
  const proposals = r.statements.filter((s) => s.accountState === 'needs_decision' && s.proposedAccountId)

  return (
    <>
      <div className="card facts">
        <p><b>Разбор:</b> {r.aiName ?? 'ответ не готов'}</p>
        {r.groups.map((g) => (
          <p key={g.key} className="row-sub">{g.aiName}: {g.complete ? 'полный' : `части ${g.have.join(',')} из ${g.parts}`}{g.isPrimary ? ' (основной)' : ''}
            {!g.isPrimary && g.complete && <button className="btn" disabled={busy} onClick={() => change((d) => { d.primary = g.key })}>Сделать основным</button>}
          </p>
        ))}
        {r.crossDiffs && (r.crossDiffs.length === 0 ? <Notice kind="ok">Два ответа совпадают по строкам и остаткам.</Notice>
          : <Notice>Ответы чатов различаются:<ul>{r.crossDiffs.map((x) => <li key={x}>{x}</li>)}</ul></Notice>)}
        <button className="btn" disabled={busy} onClick={() => confirmReset()}>Сбросить ответы</button>
      </div>

      <h2>Счета и расхождения</h2>
      {proposals.length > 1 && <button className="btn" disabled={busy} onClick={() => change((d) => { for (const s of proposals) d.accounts[s.key] = { accountId: s.proposedAccountId! } })}>Принять все предложенные счета ({proposals.length})</button>}
      {r.statements.map((s) => (
        <div key={s.key} className="card">
          <b>Карта {s.mask ?? s.key}</b>
          <span className="row-sub"> {s.periodStart ?? '?'} — {s.periodEnd ?? '?'}, строк {s.rows.length}</span>
          {s.accountState === 'skipped' && <p className="muted">Пропущена. <button className="btn" onClick={() => change((d) => { delete d.accounts[s.key] })}>Вернуть</button></p>}
          {s.accountState === 'needs_decision' && (
            <div className="form">
              <p className="warn-text">Счёт не опознан. Чат предложил: {s.aiAccountKey ?? '—'}.</p>
              <select defaultValue={s.proposedAccountId ?? ''} id={`acc-${s.key}`}>
                <option value="">— выберите счёт —</option>
                {choices.map((a) => <option key={a.id} value={a.id}>{a.name} ({a.currencyKey.toUpperCase()})</option>)}
              </select>
              <div className="actions">
                <button className="btn primary" disabled={busy} onClick={() => { const v = (document.getElementById(`acc-${s.key}`) as HTMLSelectElement).value; if (v) change((d) => { d.accounts[s.key] = { accountId: v } }) }}>Привязать</button>
                <button className="btn" disabled={busy} onClick={() => change((d) => { d.accounts[s.key] = 'skip' })}>Пропустить карту</button>
              </div>
            </div>
          )}
          {s.accountId && s.accountState !== 'skipped' && s.accountState !== 'needs_decision' && (
            <p>Счёт: <b>{accName(s.accountId)}</b>{s.bindMask ? ' (маска будет привязана при загрузке)' : ''}
              {s.openingMinor !== null && <span className="row-sub"> остаток {m(s, s.openingMinor)} → {s.closingMinor !== null ? m(s, s.closingMinor) : '?'}; приход {m(s, s.incomeMinor)}, расход {m(s, s.expenseMinor)}</span>}</p>
          )}
          {s.errors.map((e) => <p key={e.text} className="warn-text">⛔ {e.text}</p>)}
          {s.warnings.map((e) => <p key={e.text} className="muted">ℹ {e.text}</p>)}
          {s.openingDiffMinor !== null && (
            <div className="box">
              <p>Остаток на начало выписки {s.openingMinor !== null ? m(s, s.openingMinor) : '?'}, в приложении {s.openingMinor !== null ? m(s, s.openingMinor - s.openingDiffMinor) : '?'}. Разница {m(s, s.openingDiffMinor)}{s.isFirstImport ? ' (первая загрузка счёта: станет начальным остатком)' : ''}.</p>
              <div className="actions">
                <button className={`btn ${s.openingFix === 'adjust' ? 'primary' : ''}`} disabled={busy} onClick={() => change((d) => { d.openingFix[s.key] = 'adjust' })}>Корректировка на разницу</button>
                <button className={`btn ${s.openingFix === 'keep' ? 'primary' : ''}`} disabled={busy} onClick={() => change((d) => { d.openingFix[s.key] = 'keep' })}>Оставить как есть</button>
              </div>
            </div>
          )}
          {s.entryDiffMinor !== null && (
            <div className="box">
              <p>Выписка дошла до даты введённого остатка и не сходится: разница {m(s, s.entryDiffMinor)}.</p>
              <div className="actions">
                <button className={`btn ${s.entryFix === 'adjust' ? 'primary' : ''}`} disabled={busy} onClick={() => change((d) => { d.entryFix[s.key] = 'adjust' })}>Неучтённое на дату</button>
                <button className={`btn ${s.entryFix === 'keep' ? 'primary' : ''}`} disabled={busy} onClick={() => change((d) => { d.entryFix[s.key] = 'keep' })}>Оставить как есть</button>
              </div>
            </div>
          )}
        </div>
      ))}
      {r.missingCards.map((c) => <Notice key={c.accountId}>Нет данных по счёту «{c.name}»: в ответе чата его нет.</Notice>)}

      <h2>Контрагенты</h2>
      {r.own.map((o) => (
        <div key={o.mask} className="card">
          <p>Перевод на свою карту *{o.mask} ({o.count}): {o.counterpartyName ? `свой счёт «${o.counterpartyName}»` : 'контрагент «свой счёт» не найден'}.</p>
          {o.counterpartyId && <div className="actions">
            <button className={`btn ${o.decision === true ? 'primary' : ''}`} disabled={busy} onClick={() => change((d) => { d.ownAccounts[o.mask] = true })}>Это свой счёт</button>
            <button className={`btn ${o.decision === false ? 'primary' : ''}`} disabled={busy} onClick={() => change((d) => { d.ownAccounts[o.mask] = false })}>Нет</button>
          </div>}
        </div>
      ))}
      {r.cpGroups.length === 0 && <p className="muted">Нерешённых контрагентов нет.</p>}
      {r.cpGroups.map((g) => (
        <div key={g.groupKey} className="card">
          <b>{g.rawName}</b> <span className="row-sub">строк {g.count}</span>
          <p className="row-sub">{g.decision?.mode === 'new' ? 'будет создан новый' : g.decision?.mode === 'existing' ? `это: ${cps.data?.find((c) => c.id === (g.decision as { counterpartyId: string }).counterpartyId)?.name}` : 'в очередь «разобрать»'}</p>
          <div className="actions">
            <button className="btn" disabled={busy} onClick={() => change((d) => { d.counterparties[g.groupKey] = { mode: 'new' } })}>Новый</button>
            <button className="btn" disabled={busy} onClick={() => change((d) => { d.counterparties[g.groupKey] = { mode: 'queue' } })}>В очередь</button>
            <select value="" onChange={(e) => { const v = e.target.value; if (v) change((d) => { d.counterparties[g.groupKey] = { mode: 'existing', counterpartyId: v } }) }}>
              <option value="">Это существующий…</option>
              {(cps.data ?? []).filter((c) => c.kind !== 'own_account').sort((a, b) => a.name.localeCompare(b.name)).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </div>
        </div>
      ))}
      {r.identifierSuggestions.map((x) => (
        <div key={x.id} className="card">
          <p>Добавить название «{x.value}» контрагенту «{x.counterpartyName}»?</p>
          <div className="actions">
            <button className={`btn ${x.decision === 'add' ? 'primary' : ''}`} disabled={busy} onClick={() => change((d) => { d.identifiers[x.id] = 'add' })}>Добавить</button>
            <button className={`btn ${x.decision === 'reject' ? 'primary' : ''}`} disabled={busy} onClick={() => change((d) => { d.identifiers[x.id] = 'reject' })}>Нет</button>
          </div>
        </div>
      ))}

      <h2>Готово к загрузке</h2>
      {readyRows.length === 0 && <p className="muted">Пока нет карт, готовых к загрузке.</p>}
      {readyRows.map((s) => (
        <details key={s.key} className="card">
          <summary>Карта {s.mask ?? s.key}: к загрузке {s.rows.filter((x) => !x.duplicate).length}, дублей {s.rows.filter((x) => x.duplicate).length}</summary>
          <ul className="plain">{s.rows.map((x) => (
            <li key={x.n} className={x.duplicate ? 'muted' : ''}>{x.local.replace('T', ' ')} <b>{m(s, x.amountMinor)}</b> {x.description}{x.duplicate ? ' (дубль)' : ''}</li>
          ))}</ul>
        </details>
      ))}

      {r.blockers.length > 0 && <Notice>Загрузка недоступна:<ul>{r.blockers.map((b) => <li key={b}>{b}</li>)}</ul></Notice>}
      <div className="actions">
        <button className="btn" disabled={busy} onClick={rv.reload}>Проверить</button>
        <button className="btn primary" disabled={busy || !r.canLoad || !ctx.actor.isOwner} onClick={() => {
          if (window.confirm('Записать операции в базу?')) act(async () => { const x = await loadImport(ctx, job.id); return `Загружено операций: ${x.transactions}, корректировок: ${x.adjustments}, дублей пропущено: ${x.skippedDuplicates}${x.notes.length ? '. ' + x.notes.join('; ') : ''}` })
        }}>Загрузить в базу</button>
      </div>
      {msg && <div className={`box ${msg.kind}`} role={msg.kind === 'error' ? 'alert' : 'status'}>{msg.text}</div>}
    </>
  )

  function confirmReset() {
    if (window.confirm('Сбросить загруженные ответы и решения?')) act(async () => { await resetImportResponses(ctx, job.id); return 'Ответы сброшены.' })
  }
}

export function LoadedPanel({ job, onChanged }: { job: ImportJob; onChanged: () => void }) {
  const { ctx, bump } = useApp()
  const res = readReview(job).result
  const [msg, setMsg] = useState<Msg>(null)
  if (!res) return null
  async function rollback() {
    if (!window.confirm('Откатить загрузку? Операции будут помечены на удаление.')) return
    try { const n = await rollbackImport(ctx, job.id); setMsg({ kind: 'ok', text: `Помечено на удаление: ${n}` }); bump(); onChanged() } catch (e) { setMsg({ kind: 'error', text: errorText(e) }) }
  }
  return (
    <div className="card facts">
      <p>Загружено {dateTimeRu(res.loadedAt)}: операций {res.transactions}, корректировок {res.adjustments}, новых контрагентов {res.newCounterparties}, дублей пропущено {res.skippedDuplicates}.</p>
      {res.notes.map((n) => <p key={n} className="muted">{n}</p>)}
      {job.status === 'loaded' && <button className="btn" disabled={!ctx.actor.isOwner} onClick={rollback}>Откатить загрузку</button>}
      {res.rolledBackAt && <p className="muted">Откачено {dateTimeRu(res.rolledBackAt)}.</p>}
      {msg && <div className={`box ${msg.kind}`}>{msg.text}</div>}
    </div>
  )
}
