// Выписки: список задач, новая загрузка (шаг 1), страница задачи (шаги 2 и далее). Задачи хранятся в базе.
import { useState } from 'react'
import { createStatementTask, deleteStatementTask, formatMinor, listStatementTasks, recordCounterpartyUpload, taskStatement, updateTaskState } from '../../core'
import {
  applyCounterpartyFile, buildCounterpartyWorkbook, buildOperationsWorkbook, extractPdfPages, operationsFileName, parseSlspStatement, readCounterpartyWorkbook, reconcileAccount,
} from '../../core/statements'
import type { StatementTaskState } from '../../core'
import type { StatementTask } from '../../data/types'
import { useApp } from '../app'
import { useLoad } from '../hooks'
import { dateRu, dateTimeRu, errorText } from '../format'
import { BackButton, ErrorBox, Loading, Notice, Screen } from '../parts'

const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
type Msg = { kind: 'ok' | 'error'; text: string } | null
interface Picked { name: string; bytes: Uint8Array }

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

// Файл читается в память сразу при выборе (на Android иначе бывает «0 байт»); поле выбора не очищается.
async function readPicked(file: File | undefined): Promise<Picked | null> {
  if (!file) return null
  return { name: file.name, bytes: new Uint8Array(await file.arrayBuffer()) }
}

function stepLabel(t: StatementTask): string {
  const s = t.state as { counterpartiesLoaded?: boolean; operationsDone?: boolean }
  if (t.status === 'done' || s.operationsDone) return 'завершена'
  return s.counterpartiesLoaded ? 'шаг 3: операции' : 'шаг 2: контрагенты'
}

export function StatementsScreen() {
  const { ctx, go } = useApp()
  const tasks = useLoad(() => listStatementTasks(ctx), [])
  return (
    <Screen title="Выписки">
      <button className="btn primary" disabled={!ctx.actor.isOwner} onClick={() => go('statementNew')}>Новая загрузка</button>
      {tasks.loading && <Loading />}
      {tasks.error && <ErrorBox text={tasks.error} onRetry={tasks.reload} />}
      {tasks.data && tasks.data.length === 0 && <p className="muted">Загрузок пока нет.</p>}
      {tasks.data && tasks.data.length > 0 && (
        <ul className="plain rows">
          {tasks.data.map((t) => (
            <li key={t.id} className="row tap" onClick={() => go('statementTask', { accountId: t.id })}>
              <div className="row-main grow">
                <span className="row-title">{t.title}</span>
                <span className="row-sub">{dateTimeRu(t.createdAt)} · {stepLabel(t)}</span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </Screen>
  )
}

/** Шаг 1: выбрать PDF, разобрать, создать задачу. */
export function StatementNewScreen() {
  const { ctx, go, bump } = useApp()
  const [pdf, setPdf] = useState<Picked | null>(null)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<Msg>(null)

  async function start() {
    if (!pdf) return
    setBusy(true); setMsg(null)
    try {
      if (!pdf.bytes.length) throw new Error('Файл пустой (0 байт). Выберите его ещё раз, лучше из «Загрузки».')
      const st = parseSlspStatement(await extractPdfPages(pdf.bytes.slice()))
      const task = await createStatementTask(ctx, st, pdf.name)
      bump()
      go('statementTask', { accountId: task.id })
    } catch (e) { setMsg({ kind: 'error', text: errorText(e) }); setBusy(false) }
  }

  return (
    <Screen title="Новая загрузка" back={<BackButton to="statements" label="Выписки" />}>
      <div className="card">
        <p>Шаг 1. Выберите PDF выписки Slovenská sporiteľňa. Разбор идёт на телефоне; сам PDF нигде не хранится, в базу попадает только разобранное без полных номеров.</p>
        <input type="file" accept="application/pdf,.pdf" disabled={busy}
          onChange={(e) => { setMsg(null); void readPicked(e.target.files?.[0]).then(setPdf).catch((x) => setMsg({ kind: 'error', text: errorText(x) })) }} />
        {pdf && <p className="muted">Выбран: {pdf.name}</p>}
        <button className="btn primary" disabled={busy || !pdf} onClick={() => void start()}>Загрузить и разобрать</button>
      </div>
      {busy && <p className="muted">Подождите…</p>}
      {msg && <Notice kind={msg.kind === 'ok' ? 'ok' : 'warn'}>{msg.text}</Notice>}
    </Screen>
  )
}

export function StatementTaskScreen({ taskId }: { taskId: string }) {
  const { ctx } = useApp()
  const task = useLoad(async () => (await listStatementTasks(ctx)).find((t) => t.id === taskId) ?? null, [taskId])
  return (
    <Screen title="Загрузка выписки" back={<BackButton to="statements" label="Выписки" />}>
      {task.loading && <Loading />}
      {task.error && <ErrorBox text={task.error} onRetry={task.reload} />}
      {task.data === null && !task.loading && !task.error && <p className="muted">Задача не найдена (возможно, удалена).</p>}
      {task.data && <TaskView task={task.data} reload={task.reload} />}
    </Screen>
  )
}

function TaskView({ task, reload }: { task: StatementTask; reload: () => void }) {
  const { ctx, go, bump } = useApp()
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<Msg>(null)
  const [xlsx, setXlsx] = useState<Picked | null>(null)
  const st = taskStatement(task)
  const state = task.state as StatementTaskState

  async function run(fn: () => Promise<string>) {
    setBusy(true); setMsg(null)
    try { setMsg({ kind: 'ok', text: await fn() }); reload() } catch (e) { setMsg({ kind: 'error', text: errorText(e) }) } finally { setBusy(false) }
  }
  const download = () => run(async () => {
    const a = st.accounts[0]!
    const name = `kontragenty_${a.periodEnd.slice(0, 7)}.xlsx`
    await saveFile(name, await buildCounterpartyWorkbook(ctx, st), XLSX)
    await updateTaskState(ctx, task.id, { counterpartyFileDownloaded: true })
    return `Файл создан: ${name}. Впишите имена во 2-ю колонку и загрузите обратно.`
  })
  const upload = () => run(async () => {
    if (!xlsx) return ''
    const r = await applyCounterpartyFile(ctx, await readCounterpartyWorkbook(xlsx.bytes.slice()))
    await recordCounterpartyUpload(ctx, task.id, xlsx.name, { ...r, rows: r.rowsLinked })
    bump()
    return `Принято. Строк: ${r.rowsLinked}, новых контрагентов: ${r.created}, признаков добавлено: ${r.identifiersAdded}${r.reassigned ? `, переназначено: ${r.reassigned}` : ''}.`
  })
  const downloadOps = () => run(async () => {
    const name = operationsFileName(st)
    await saveFile(name, await buildOperationsWorkbook(ctx, st), XLSX)
    if (!state.operationsDone) await updateTaskState(ctx, task.id, { operationsDone: true })
    return `Файл создан: ${name}. Строки с расхождением сверки подсвечены красным.`
  })
  async function remove() {
    if (!window.confirm('Удалить загрузку? Разобранные данные будут стёрты. Уже записанные контрагенты останутся.')) return
    setBusy(true)
    try { await deleteStatementTask(ctx, task.id); bump(); go('statements') } catch (e) { setMsg({ kind: 'error', text: errorText(e) }); setBusy(false) }
  }

  return (
    <>
      <p><b>{task.title}</b></p>
      <div className="card">
        <p>✓ Шаг 1. Файл разобран</p>
        <p className="muted">Файл: {task.fileName} · {dateTimeRu(task.createdAt)}</p>
        {st.accounts.map((a) => {
          const rec = reconcileAccount(a)
          return (
            <div key={a.key}>
              <p>{a.title} …{a.key} · {a.currency} · {dateRu(a.periodStart)} — {dateRu(a.periodEnd)}, операций: {a.rows.length}</p>
              <p className="muted">Остаток: {formatMinor(a.openingMinor, 2)} → {formatMinor(a.closingMinor, 2)}</p>
              {rec.ok ? <Notice kind="ok">Сверка сошлась до копейки.</Notice>
                : <Notice kind="warn">НЕ СОШЛОСЬ{rec.firstBadRow ? `: первая строка ${rec.firstBadRow}` : ''}. Строк с расхождением: {rec.badRows.length}.</Notice>}
            </div>
          )
        })}
      </div>
      <div className="card">
        <p>{state.counterpartiesLoaded ? '✓' : '→'} Шаг 2. Контрагенты</p>
        {state.counterpartiesLoaded && state.counterpartiesTotals && (
          <Notice kind="ok">
            Загружен файл {state.counterpartiesFile}{state.counterpartiesAt ? ` (${dateTimeRu(state.counterpartiesAt)})` : ''}. Результат: новых контрагентов {state.counterpartiesTotals.created}, признаков добавлено {state.counterpartiesTotals.identifiersAdded}{state.counterpartiesTotals.reassigned ? `, переназначено ${state.counterpartiesTotals.reassigned}` : ''}.
          </Notice>
        )}
        {!state.counterpartiesLoaded && state.counterpartyFileDownloaded && <p className="muted">Файл контрагентов уже скачан. Теперь правьте его и загрузите ниже.</p>}
        <p className="muted">{state.counterpartiesLoaded ? 'Если нужно что-то поправить, скачайте файл ещё раз и загрузите снова.' : 'Скачайте файл, впишите во 2-ю колонку имена из справочника (пусто = новый контрагент), загрузите обратно. Если в файле ошибка, ничего не записывается.'}</p>
        <button className="btn primary" disabled={busy} onClick={() => void download()}>Скачать файл контрагентов</button>
        <input type="file" accept=".xlsx" disabled={busy}
          onChange={(e) => { setMsg(null); void readPicked(e.target.files?.[0]).then(setXlsx).catch((x) => setMsg({ kind: 'error', text: errorText(x) })) }} />
        {xlsx && <p className="muted">Выбран: {xlsx.name}</p>}
        <button className="btn primary" disabled={busy || !xlsx} onClick={() => void upload()}>Загрузить правленый файл</button>
      </div>
      <div className="card">
        <p className={state.counterpartiesLoaded ? '' : 'muted'}>{state.operationsDone ? '✓' : state.counterpartiesLoaded ? '→' : '○'} Шаг 3. Файл «Операции + Сверка»</p>
        {!state.counterpartiesLoaded && <p className="muted">Станет доступен после шага 2.</p>}
        {state.counterpartiesLoaded && (
          <>
            <p className="muted">{state.operationsDone ? 'Файл уже создавался. Можно скачать ещё раз (например, после правки контрагентов).' : 'Листы «Операции» и «Сверка»; контрагенты из справочника; расхождения красным. В базу ничего не пишется.'}</p>
            <button className="btn primary" disabled={busy} onClick={() => void downloadOps()}>Скачать «Операции + Сверка»</button>
          </>
        )}
      </div>
      {busy && <p className="muted">Подождите…</p>}
      {msg && <Notice kind={msg.kind === 'ok' ? 'ok' : 'warn'}>{msg.text}</Notice>}
      <button className="btn" disabled={busy} onClick={() => void remove()}>Удалить загрузку</button>
    </>
  )
}
