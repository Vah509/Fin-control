import { useState } from 'react'
import { cancelImportJob, createImportJob, getImportJob, listImportableAccounts, listImportJobs } from '../../core'
import type { ImportJob, ImportJobStatus } from '../../data/types'
import { useApp } from '../app'
import { useLoad } from '../hooks'
import { dateTimeRu, errorText, localInputToIso, money, parseAmountInput, toLocalInput } from '../format'
import { BackButton, ErrorBox, Loading, Notice, Screen } from '../parts'

const STATUS: Record<ImportJobStatus, string> = {
  preparing: 'подготовка', waiting_file: 'ждёт файла', review: 'разбор', loaded: 'загружено', cancelled: 'отменено',
}

export function ImportsScreen() {
  const { ctx, go } = useApp()
  const jobs = useLoad(() => listImportJobs(ctx), [])
  return (
    <Screen title="Загрузка выписок" back={<BackButton to="more" label="Прочее" />}>
      {!ctx.actor.isOwner && <Notice>Задания на импорт доступны только владельцу.</Notice>}
      <button className="btn primary" disabled={!ctx.actor.isOwner} onClick={() => go('importNew')}>Новое задание</button>
      {jobs.loading && <Loading />}
      {jobs.error && <ErrorBox text={jobs.error} onRetry={jobs.reload} />}
      {jobs.data && jobs.data.length === 0 && <p className="muted">Заданий пока нет.</p>}
      {jobs.data && jobs.data.length > 0 && (
        <ul className="plain rows">
          {jobs.data.map((j) => (
            <li key={j.id} className="row tap" onClick={() => go('importJob', { accountId: j.id })}>
              <div className="row-main grow">
                <span className="row-title">{dateTimeRu(j.createdAt)}</span>
                <span className="row-sub">счетов: {j.accounts.length}, {STATUS[j.status]}</span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </Screen>
  )
}

interface Pick { text: string; when: string }

export function ImportNewScreen() {
  const { ctx, ref, go, bump } = useApp()
  const accounts = useLoad(() => listImportableAccounts(ctx), [])
  const [picked, setPicked] = useState<Record<string, Pick>>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const decimalsOf = (cur: string) => ref.cur.get(cur)?.decimals ?? 2

  const list = accounts.data ?? []
  const items = list.filter((a) => picked[a.id]).map((a) => {
    const p = picked[a.id]!
    return { a, parsed: parseAmountInput(p.text, decimalsOf(a.currencyKey)), iso: localInputToIso(p.when) }
  })
  const ready = items.length > 0 && items.every((x) => x.parsed && 'minor' in x.parsed && x.iso)

  function toggle(id: string) {
    setPicked((s) => {
      const n = { ...s }
      if (n[id]) delete n[id]; else n[id] = { text: '', when: toLocalInput() }
      return n
    })
  }
  const set = (id: string, patch: Partial<Pick>) => setPicked((s) => ({ ...s, [id]: { ...s[id]!, ...patch } }))

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (!ready) return
    setBusy(true); setError(null)
    try {
      const job = await createImportJob(ctx, {
        accounts: items.map((x) => ({ accountId: x.a.id, balanceMinor: (x.parsed as { minor: number }).minor, asOf: x.iso! })),
      })
      bump()
      go('importJob', { accountId: job.id })
    } catch (err) { setError(errorText(err)) } finally { setBusy(false) }
  }

  return (
    <Screen title="Новое задание" back={<BackButton to="imports" label="Загрузка выписок" />}>
      <p className="muted">Выберите счета, по которым есть выписка, и введите остаток, который сейчас показывает банк.</p>
      {accounts.loading && <Loading />}
      {accounts.error && <ErrorBox text={accounts.error} onRetry={accounts.reload} />}
      {accounts.data && list.length === 0 && <Notice>Нет активных счетов в режиме «остатки и движения».</Notice>}
      <form onSubmit={submit} className="form">
        {list.map((a) => {
          const p = picked[a.id]
          const it = items.find((x) => x.a.id === a.id)
          return (
            <div key={a.id} className="card">
              <label className="check">
                <input type="checkbox" checked={!!p} onChange={() => toggle(a.id)} />
                <span>{a.name} <span className="muted">{a.currencyKey.toUpperCase()}</span></span>
              </label>
              {p && (
                <>
                  <label>Остаток в банке ({a.currencyKey.toUpperCase()})
                    <input inputMode="decimal" value={p.text} onChange={(e) => set(a.id, { text: e.target.value })} placeholder="0.00" />
                  </label>
                  {it?.parsed && 'error' in it.parsed && <p className="warn-text">{it.parsed.error}</p>}
                  {it?.parsed && 'minor' in it.parsed && <p className="row-sub">{money(it.parsed.minor, decimalsOf(a.currencyKey))} {a.currencyKey.toUpperCase()}</p>}
                  <label>На момент
                    <input type="datetime-local" value={p.when} onChange={(e) => set(a.id, { when: e.target.value })} />
                  </label>
                </>
              )}
            </div>
          )
        })}
        {error && <div className="box error" role="alert">{error}</div>}
        <button className="btn primary" disabled={busy || !ready || !ctx.actor.isOwner}>{busy ? 'Готовим…' : 'Создать задание и пакет'}</button>
      </form>
    </Screen>
  )
}

function download(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/markdown' }))
  const a = document.createElement('a')
  a.href = url; a.download = name
  document.body.appendChild(a); a.click(); a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}

export function ImportJobScreen({ jobId }: { jobId: string }) {
  const { ctx, ref, bump } = useApp()
  const job = useLoad(() => getImportJob(ctx, jobId), [jobId])
  return (
    <Screen title="Задание на импорт" back={<BackButton to="imports" label="Загрузка выписок" />}>
      {job.loading && <Loading />}
      {job.error && <ErrorBox text={job.error} onRetry={job.reload} />}
      {job.data && <JobView job={job.data} refData={ref} onChanged={() => { bump(); job.reload() }} />}
    </Screen>
  )
}

function JobView({ job, refData, onChanged }: { job: ImportJob; refData: ReturnType<typeof useApp>['ref']; onChanged: () => void }) {
  const { ctx } = useApp()
  const [msg, setMsg] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const name = `import-task-${job.id.slice(0, 8)}.md`
  const open = job.status === 'preparing' || job.status === 'waiting_file'

  async function share() {
    setMsg(null)
    const file = new File([job.packageText], name, { type: 'text/markdown' })
    if (navigator.canShare?.({ files: [file] })) {
      try { await navigator.share({ files: [file], title: name }); return } catch (e) {
        if ((e as Error).name === 'AbortError') return
      }
    }
    download(name, job.packageText)
  }
  async function copy() {
    try { await navigator.clipboard.writeText(job.packageText); setMsg({ kind: 'ok', text: 'Пакет скопирован.' }) }
    catch (e) { setMsg({ kind: 'error', text: errorText(e) }) }
  }
  async function cancel() {
    if (!window.confirm('Отменить задание? Пакет станет недействительным.')) return
    setBusy(true); setMsg(null)
    try { await cancelImportJob(ctx, job.id); onChanged() } catch (e) { setMsg({ kind: 'error', text: errorText(e) }) } finally { setBusy(false) }
  }

  return (
    <>
      <div className="card facts">
        <p><b>{STATUS[job.status]}</b>, создано {dateTimeRu(job.createdAt)}</p>
        <ul className="plain">
          {job.accounts.map((ja) => {
            const a = refData.accounts.find((x) => x.id === ja.accountId)
            const dec = a ? refData.cur.get(a.currencyKey)?.decimals ?? 2 : 2
            return (
              <li key={ja.accountId}>
                <span>{a?.name ?? ja.accountId}</span>
                <b>{money(ja.balanceMinor, dec)} {a?.currencyKey.toUpperCase()}</b>
                <span className="row-sub">на {dateTimeRu(ja.asOf)}</span>
              </li>
            )
          })}
        </ul>
      </div>
      <div className="card">
        <h2>Пакет для ИИ-чата</h2>
        <p className="muted">Отправьте файл в новый чат (Claude или Gemini) вместе с выписками. Реальные выписки в репозиторий не кладите.</p>
        <div className="actions">
          <button className="btn primary" onClick={share}>Поделиться</button>
          <button className="btn" onClick={copy}>Копировать</button>
          <button className="btn" onClick={() => download(name, job.packageText)}>Скачать</button>
        </div>
        <details><summary>Показать текст пакета</summary><pre className="pre">{job.packageText}</pre></details>
      </div>
      {open && <button className="btn" disabled={busy || !ctx.actor.isOwner} onClick={cancel}>Отменить задание</button>}
      {msg && <div className={`box ${msg.kind}`} role={msg.kind === 'error' ? 'alert' : 'status'}>{msg.text}</div>}
    </>
  )
}
