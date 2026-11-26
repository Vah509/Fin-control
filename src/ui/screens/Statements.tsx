// Выписки: список задач, новая загрузка (шаг 1), страница задачи (шаги 2 и далее). Задачи хранятся в базе.
import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { compareTask, createStatementTask, deleteStatementTask, checkTaskBalances, planTaskOpeningFixes, applyTaskOpeningFixes, finishStatementTask, formatMinor, listStatementTasks, listTaskProblems, recordCounterpartyUpload, resolveProblem, taskAccountsStatus, identifyStatementAccount, confirmAccountsRecognized, confirmCounterpartiesRecognized, saveComparison, taskStatement, updateTaskState } from '../../core'
import type { ProblemAction, ProblemDetails } from '../../core'
import {
  applyCounterpartyFile, buildCounterpartyWorkbook, counterpartyStatus, buildOperationsWorkbook, extractPdfPages, operationsFileName, parseSlspStatement, readCounterpartyWorkbook, reconcileAccount,
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
  const s = t.state as { accountsConfirmed?: boolean; counterpartiesLoaded?: boolean; operationsDone?: boolean; problemsCount?: number }
  if (t.status === 'done' || s.operationsDone) return 'завершена'
  if (s.problemsCount) return `шаг 4: проблем ${s.problemsCount}`
  return s.counterpartiesLoaded ? 'шаг 4: операции' : s.accountsConfirmed ? 'шаг 3: контрагенты' : 'шаг 2: счёт'
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

const KIND_RU: Record<string, string> = {
  db_only: 'Есть в базе, нет в выписке', account_missing: 'Счёт не найден в базе', transfer_unpaired: 'Перевод без пары',
  amount_mismatch: 'Сумма расходится', date_mismatch: 'Дата расходится',
}
const HELP: Record<string, string> = {
  db_only: 'Операция есть в базе за период выписки, но в выписке её нет.',
  amount_mismatch: 'В базе найдена операция того же контрагента (±3 дня), сумма другая.',
  account_missing: 'Выписка относится к счёту, которого нет в базе (или у него нет признака «последние 4 цифры»).',
  transfer_unpaired: 'Перевод на свой счёт, парную запись создать нельзя.',
  date_mismatch: 'Нужна доработка: в базе есть операция с той же суммой, но датой в пределах 3 дней. Решения пока нет, запись заблокирована.',
}

export function StatementAccountScreen({ taskId }: { taskId: string }) {
  const { ctx, bump, go } = useApp()
  const list = useLoad(() => taskAccountsStatus(ctx, taskId), [taskId])
  const accounts = useLoad(() => ctx.storage.list('accounts'), [])
  const [pick, setPick] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<Msg>(null)
  const NEW = 'new'

  async function save(key: string) {
    setBusy(true); setMsg(null)
    try {
      const status = await identifyStatementAccount(ctx, taskId, key, pick[key]!)
      bump()
      if (status.every((x) => x.account)) go('statementTask', { accountId: taskId })
      else { list.reload(); setMsg({ kind: 'ok', text: 'Признак сохранён.' }) }
    } catch (e) { setMsg({ kind: 'error', text: errorText(e) }) } finally { setBusy(false) }
  }

  return (
    <Screen title="Опознать счёт" back={<BackButton to="statementTask" label="Загрузка" />}>
      {list.loading && <Loading />}
      {list.error && <ErrorBox text={list.error} onRetry={list.reload} />}
      {msg && <Notice kind={msg.kind === 'ok' ? 'ok' : 'warn'}>{msg.text}</Notice>}
      {list.data && list.data.filter((x) => !x.account).length === 0 && <p className="muted">Все счета опознаны. Вернитесь назад и нажмите «Следующий шаг».</p>}
      {list.data && list.data.filter((x) => !x.account).map((x) => {
        const cands = (accounts.data ?? []).filter((a) => !a.archivedAt && a.currencyKey.toUpperCase() === x.currency.toUpperCase())
        const v = pick[x.key] ?? ''
        return (
          <div key={x.key} className="card">
            <p><b>Счёт неопознан</b>: …{x.key} {x.title} · {x.currency}</p>
            <select value={v} disabled={busy} onChange={(e) => setPick({ ...pick, [x.key]: e.target.value })}>
              <option value="">Выберите счёт ({x.currency})</option>
              {cands.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
              <option value={NEW}>Новый счёт</option>
            </select>
            {v === NEW && (
              <Notice kind="warn">Заведите новый счёт (Счета, новый счёт): валюта {x.currency}. Затем вернитесь сюда, выберите его в списке и сохраните признак «последние 4 цифры …{x.key}». После этого счёт будет опознаваться сам. Повторите шаг.</Notice>
            )}
            <button className="btn primary" disabled={busy || !v || v === NEW} onClick={() => void save(x.key)}>Сохранить признак …{x.key}</button>
          </div>
        )
      })}
    </Screen>
  )
}

export function StatementProblemsScreen({ taskId }: { taskId: string }) {
  const { ctx, bump } = useApp()
  const list = useLoad(() => listTaskProblems(ctx, taskId), [taskId])
  const accounts = useLoad(() => ctx.storage.list('accounts'), [])
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<Msg>(null)
  const [pick, setPick] = useState<Record<string, string>>({})

  async function act(id: string, action: ProblemAction, ask?: string) {
    if (ask && !window.confirm(ask)) return
    setBusy(true); setMsg(null)
    try { await resolveProblem(ctx, taskId, id, action); bump(); list.reload(); setMsg({ kind: 'ok', text: 'Готово. Список пересчитан.' }) }
    catch (e) { setMsg({ kind: 'error', text: errorText(e) }); list.reload() } finally { setBusy(false) }
  }
  const B = ({ id, action, label, ask }: { id: string; action: ProblemAction; label: string; ask?: string }) => (
    <button className="btn" disabled={busy} onClick={() => void act(id, action, ask)}>{label}</button>
  )

  return (
    <Screen title="Проблемы выписки" back={<BackButton to="statementTask" label="Загрузка" />}>
      {list.loading && <Loading />}
      {list.error && <ErrorBox text={list.error} onRetry={list.reload} />}
      {msg && <Notice kind={msg.kind === 'ok' ? 'ok' : 'warn'}>{msg.text}</Notice>}
      {list.data && list.data.length === 0 && <p className="muted">Проблем нет. Вернитесь на страницу загрузки, шаг 5.</p>}
      {list.data && list.data.length > 0 && (
        <>
          <p className="muted">Пока есть проблемы, выписка в базу не записывается. Решённая проблема исчезает из списка.</p>
          <ul className="plain rows">
            {list.data.map((p) => {
              const d = p.details as unknown as ProblemDetails
              const cands = (accounts.data ?? []).filter((x) => !x.archivedAt && x.currencyKey.toUpperCase() === (d.currency ?? '').toUpperCase())
              return (
                <li key={p.id} className="card">
                  <p><b>{KIND_RU[p.kind] ?? p.kind}</b>{d.date ? ` · ${dateRu(d.date)}` : ''}{d.amountMinor !== null ? ` · ${formatMinor(d.amountMinor, 2)} ${d.currency ?? ''}` : ''}</p>
                  <p className="muted">…{d.accountKey} {d.accountName}{d.n ? ` · строка ${d.n}` : ''}{d.counterparty ? ` · ${d.counterparty}` : ''}{d.comment ? ` · ${d.comment}` : ''}</p>
                  {d.dbAmountMinor !== undefined && <p className="muted">В базе: {formatMinor(d.dbAmountMinor, 2)} {d.currency}{d.dbDate ? ` · ${dateRu(d.dbDate)}` : ''}</p>}
                  {d.message && <p className="muted">{d.message}</p>}
                  <p className="muted">{HELP[p.kind] ?? 'Нужна доработка: решения для этого вида проблем пока нет.'}</p>
                  {p.kind === 'db_only' && (<>
                    <B id={p.id} action={{ kind: 'keep' }} label="Оставить" />
                    <B id={p.id} action={{ kind: 'delete' }} label="Удалить из базы" ask="Операция будет помечена удалённой (парная запись перевода тоже). Продолжить?" />
                  </>)}
                  {p.kind === 'amount_mismatch' && (<>
                    <B id={p.id} action={{ kind: 'accept_statement' }} label="Принять сумму выписки" ask="Сумма и дата операции в базе будут заменены данными выписки. Продолжить?" />
                    <B id={p.id} action={{ kind: 'keep_base' }} label="Оставить как в базе" />
                    <B id={p.id} action={{ kind: 'distinct' }} label="Это разные операции" />
                  </>)}
                  {p.kind === 'transfer_unpaired' && <B id={p.id} action={{ kind: 'plain' }} label="Записать как обычный расход/приход" />}
                  {p.kind === 'account_missing' && (<>
                    <select value={pick[p.id] ?? ''} disabled={busy} onChange={(e) => setPick({ ...pick, [p.id]: e.target.value })}>
                      <option value="">Выберите счёт ({d.currency})</option>
                      {cands.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
                    </select>
                    <button className="btn" disabled={busy || !pick[p.id]} onClick={() => void act(p.id, { kind: 'add_identifier', accountId: pick[p.id]! }, `Добавить счёту признак «последние 4 цифры …${d.accountKey}»?`)}>Добавить признак …{d.accountKey}</button>
                    <p className="muted">Нужного счёта нет: создайте его в «Счета → Новый счёт», затем вернитесь сюда.</p>
                  </>)}
                </li>
              )
            })}
          </ul>
        </>
      )}
    </Screen>
  )
}

type StepStatus = 'done' | 'current' | 'future'

/** Шаг-аккордеон: заголовок из двух строк (название, результат), ⓘ со справкой, тело раскрывается нажатием. Будущие шаги нейтральные и не раскрываются. */
function Step({ title, summary, status, open, onToggle, info, children }: {
  title: string; summary: string; status: StepStatus; open: boolean; onToggle: () => void; info?: string; children?: ReactNode
}) {
  const [help, setHelp] = useState(false)
  const expandable = status !== 'future'
  return (
    <div className={`acc ${status}`}>
      <div className="acc-head">
        <button type="button" className="acc-main" disabled={!expandable} onClick={onToggle} aria-expanded={open}>
          <span className="acc-mark">{status === 'done' ? '✓' : status === 'current' ? '→' : '○'}</span>
          <span className="acc-text"><span className="acc-title">{title}</span><span className="acc-sum">{summary}</span></span>
          {expandable && <span className="acc-chev">{open ? '▾' : '▸'}</span>}
        </button>
        {info && expandable && <button type="button" className="acc-info" aria-label="Справка" aria-expanded={help} onClick={() => setHelp(!help)}>ⓘ</button>}
      </div>
      {info && help && expandable && <div className="acc-help">{info}</div>}
      {open && expandable && <div className="acc-body">{children}</div>}
    </div>
  )
}

function TaskView({ task, reload }: { task: StatementTask; reload: () => void }) {
  const { ctx, go, bump } = useApp()
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<Msg>(null)
  const [xlsx, setXlsx] = useState<Picked | null>(null)
  const [openMap, setOpenMap] = useState<Record<number, boolean>>({})
  const auto = useRef<Set<string>>(new Set())
  const st = taskStatement(task)
  const state = task.state as StatementTaskState
  const accs = useLoad(() => taskAccountsStatus(ctx, task.id), [task.id, task.updatedAt])
  const allAccountsKnown = !!accs.data && accs.data.length > 0 && accs.data.every((x) => x.account)
  const accountsPassed = !!state.accountsConfirmed || !!state.counterpartiesLoaded
  const cps = useLoad(() => counterpartyStatus(ctx, st), [task.id, task.updatedAt])
  const allKnown = !!cps.data && cps.data.unrecognized.length === 0
  const problems = state.problemsCount ?? 0
  const compared = !!state.comparedAt
  const closed = !!state.operationsDone
  const ready = !!state.counterpartiesLoaded && compared && problems === 0 && !closed

  async function run(fn: () => Promise<string>) {
    setBusy(true); setMsg(null)
    try { setMsg({ kind: 'ok', text: await fn() }); reload() } catch (e) { setMsg({ kind: 'error', text: errorText(e) }) } finally { setBusy(false) }
  }

  // Автопереходы: счета опознаны → шаг 3; контрагенты опознаны → шаг 4; на шаге 4 сравнение с базой идёт само (файл скачивается по кнопке).
  useEffect(() => {
    if (busy || closed || task.status === 'done') return
    const once = (k: string, fn: () => Promise<void>) => {
      if (auto.current.has(k)) return
      auto.current.add(k)
      setBusy(true)
      void fn().then(() => { bump(); reload() }).catch((e) => setMsg({ kind: 'error', text: errorText(e) })).finally(() => setBusy(false))
    }
    if (!accountsPassed) { if (allAccountsKnown) once('acc', async () => { await confirmAccountsRecognized(ctx, task.id) }) }
    else if (!state.counterpartiesLoaded) { if (allKnown) once('cp', async () => { await confirmCounterpartiesRecognized(ctx, task.id) }) }
    else if (!compared) once('cmp', async () => { await saveComparison(ctx, task.id, await compareTask(ctx, task.id)) })
  }, [busy, closed, task.status, accountsPassed, allAccountsKnown, allKnown, state.counterpartiesLoaded, compared, ctx, task.id, bump, reload])

  const bal = useLoad(() => (ready ? checkTaskBalances(ctx, task.id) : Promise.resolve(null)), [task.id, task.updatedAt, ready])
  const fixes = useLoad(() => (ready && bal.data && !bal.data.ok ? planTaskOpeningFixes(ctx, task.id) : Promise.resolve(null)), [task.id, task.updatedAt, ready, bal.data])
  const applyFix = (key: string) => run(async () => { await applyTaskOpeningFixes(ctx, task.id, [key]); bump(); bal.reload(); return 'Начальный остаток записан. Остатки проверены заново.' })
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
    return `Принято. Строк: ${r.rowsLinked}, новых контрагентов: ${r.created}, признаков добавлено: ${r.identifiersAdded}${r.tagsSet ? `, тегов проставлено: ${r.tagsSet}` : ''}${r.reassigned ? `, переназначено: ${r.reassigned}` : ''}.`
  })
  const downloadOps = () => run(async () => {
    const name = operationsFileName(st)
    const cmp = await compareTask(ctx, task.id)
    await saveComparison(ctx, task.id, cmp)
    await saveFile(name, await buildOperationsWorkbook(ctx, st, cmp), XLSX)
    bump()
    return `Файл создан: ${name}. Проблем: ${cmp.problems.length}.`
  })
  const finish = () => run(async () => {
    const r = await finishStatementTask(ctx, task.id); bump()
    return r.written === 0 ? 'Задача закрыта, новых записей нет.' : `Записано операций в базу: ${r.written}. Задача закрыта.`
  })
  async function remove() {
    if (!window.confirm('Удалить задачу? Разобранные данные будут стёрты. Уже записанные контрагенты останутся.')) return
    setBusy(true)
    try { await deleteStatementTask(ctx, task.id); bump(); go('statements') } catch (e) { setMsg({ kind: 'error', text: errorText(e) }); setBusy(false) }
  }

  // статусы шагов
  const s2: StepStatus = accountsPassed ? 'done' : 'current'
  const s3: StepStatus = state.counterpartiesLoaded ? 'done' : accountsPassed ? 'current' : 'future'
  const s4: StepStatus = closed || (compared && problems === 0) ? 'done' : state.counterpartiesLoaded ? 'current' : 'future'
  const s5: StepStatus = closed ? 'done' : ready ? 'current' : 'future'
  const isOpen = (n: number, s: StepStatus) => openMap[n] ?? s === 'current'
  const toggle = (n: number, s: StepStatus) => setOpenMap({ ...openMap, [n]: !isOpen(n, s) })

  const recs = st.accounts.map((a) => reconcileAccount(a))
  const opsTotal = st.accounts.reduce((n, a) => n + a.rows.length, 0)
  const s1sum = `${opsTotal} операций · ${recs.every((r) => r.ok) ? 'сверка сошлась' : 'НЕ СОШЛОСЬ'}`
  const s2sum = s2 === 'done' || allAccountsKnown
    ? (accs.data ?? []).map((x) => `…${x.key} ${x.account ? x.account.name : 'неопознан'}`).join('; ') || 'Счета опознаны'
    : 'Нужно опознать счёт'
  const s3sum = s3 === 'future' ? 'Ожидает шага 2'
    : cps.data ? `Контрагентов ${cps.data.total} · опознано ${cps.data.recognized}${state.counterpartiesTotals?.created ? ` · новых ${state.counterpartiesTotals.created}` : ''}${cps.data.unrecognized.length ? ` · не опознано ${cps.data.unrecognized.length}` : ''}` : 'Проверяю…'
  const nowrite = state.newCount === 0
  const s4sum = s4 === 'future' ? 'Ожидает шага 3'
    : !compared ? 'Сравниваю с базой…'
    : problems > 0 ? `Проблем: ${problems}. Нужно решить`
    : closed || state.newCount === undefined ? 'Проблем нет'
    : nowrite ? 'Операции уже записаны в базе, новых записей: 0'
    : `Проблем нет · новых записей: ${state.newCount}, уже в базе: ${state.inDbCount ?? 0}`
  const s5sum = s5 === 'done' ? `Задача закрыта, записано операций: ${state.writtenCount ?? 0}`
    : s5 === 'future' ? 'Ожидает шага 4'
    : !bal.data ? 'Проверяю остатки…'
    : !bal.data.ok ? 'Остатки не сходятся. Запись заблокирована'
    : bal.data.newCount === 0 ? 'Остатки сходятся. Операции уже в базе, новых 0' : `Остатки сходятся. К записи: ${bal.data.newCount}`

  return (
    <>
      <p><b>{task.title}</b></p>
      <Step title="Шаг 1. Файл разобран" summary={s1sum} status="done" open={isOpen(1, 'done')} onToggle={() => toggle(1, 'done')}>
        <p className="muted">Файл: {task.fileName} · {dateTimeRu(task.createdAt)}</p>
        {st.accounts.map((a, i) => (
          <div key={a.key}>
            <p>{a.title} …{a.key} · {a.currency} · {dateRu(a.periodStart)} — {dateRu(a.periodEnd)}, операций: {a.rows.length}</p>
            <p className="muted">Остаток: {formatMinor(a.openingMinor, 2)} → {formatMinor(a.closingMinor, 2)}</p>
            {recs[i]!.ok ? <Notice kind="ok">Сверка сошлась до копейки.</Notice>
              : <Notice kind="warn">НЕ СОШЛОСЬ{recs[i]!.firstBadRow ? `: первая строка ${recs[i]!.firstBadRow}` : ''}. Строк с расхождением: {recs[i]!.badRows.length}.</Notice>}
          </div>
        ))}
      </Step>
      <Step title="Шаг 2. Опознание счёта" summary={s2sum} status={s2} open={isOpen(2, s2)} onToggle={() => toggle(2, s2)}>
        {accs.loading && <p className="muted">Проверяю…</p>}
        {accs.error && <ErrorBox text={accs.error} onRetry={accs.reload} />}
        {accs.data && accs.data.map((x) => (
          <p key={x.key}>…{x.key} {x.title}: {x.account ? <>счёт «{x.account.name}»</> : <b>счёт неопознан</b>}</p>
        ))}
        {!accountsPassed && accs.data && !allAccountsKnown && (
          <button className="btn primary" disabled={busy} onClick={() => go('statementAccount', { accountId: task.id })}>Опознать счёт</button>
        )}
      </Step>
      <Step title="Шаг 3. Контрагенты" summary={s3sum} status={s3} open={isOpen(3, s3)} onToggle={() => toggle(3, s3)}
        info="Скачайте файл, впишите во 2-ю колонку имена из справочника (пусто = новый контрагент), загрузите обратно. Если в файле ошибка, ничего не записывается. Если все опознаны, файл не обязателен: шаг пройдёт сам, файл можно скачать для проверки, пока задача не удалена.">
        {state.counterpartiesLoaded && state.counterpartiesTotals && state.counterpartiesFile && (
          <Notice kind="ok">
            Загружен файл {state.counterpartiesFile}{state.counterpartiesAt ? ` (${dateTimeRu(state.counterpartiesAt)})` : ''}. Новых контрагентов {state.counterpartiesTotals.created}, признаков добавлено {state.counterpartiesTotals.identifiersAdded}{state.counterpartiesTotals.reassigned ? `, переназначено ${state.counterpartiesTotals.reassigned}` : ''}.
          </Notice>
        )}
        {cps.data && <p>Контрагентов в выписке: {cps.data.total} · опознано: {cps.data.recognized} · не опознано: {cps.data.unrecognized.length}</p>}
        {cps.data && cps.data.unrecognized.length > 0 && (
          <p className="muted">Не опознаны: {cps.data.unrecognized.slice(0, 5).map((g) => g.text).join('; ')}{cps.data.unrecognized.length > 5 ? ` и ещё ${cps.data.unrecognized.length - 5}` : ''}</p>
        )}
        {!state.counterpartiesLoaded && state.counterpartyFileDownloaded && !allKnown && <p className="muted">Файл уже скачан. Правьте его и загрузите ниже.</p>}
        <button className={allKnown ? 'btn' : 'btn primary'} disabled={busy} onClick={() => void download()}>Скачать файл контрагентов</button>
        <input type="file" accept=".xlsx" disabled={busy}
          onChange={(e) => { setMsg(null); void readPicked(e.target.files?.[0]).then(setXlsx).catch((x) => setMsg({ kind: 'error', text: errorText(x) })) }} />
        {xlsx && <p className="muted">Выбран: {xlsx.name}</p>}
        <button className="btn primary" disabled={busy || !xlsx} onClick={() => void upload()}>Загрузить правленый файл</button>
      </Step>
      <Step title="Шаг 4. Операции + сверка" summary={s4sum} status={s4} open={isOpen(4, s4)} onToggle={() => toggle(4, s4)}
        info="Приложение сравнивает выписку с операциями в базе за период выписки. Нормально: операции нет в базе (будет записана) или она есть и там и там. Проблемы (запись блокируется, пока они есть): операция есть в базе, а в выписке нет; счёта выписки нет в базе; перевод на свой счёт, для которого нельзя создать пару (другая валюта, счёт не привязан). Запись в базу выполняется на шаге 5 после сверки остатков. В файле плюсы в колонках «В выписке» и «В базе».">
        {compared && state.newCount === 0 && problems === 0 && <Notice kind="ok">Операции уже записаны в базе, новых записей: 0.</Notice>}
        {compared && !closed && problems === 0 && (state.newCount ?? 0) > 0 && <Notice kind="ok">Проблем нет. Новых записей: {state.newCount}, уже в базе: {state.inDbCount ?? 0}.</Notice>}
        {compared && (state.missingAccounts?.length ?? 0) > 0 && (
          <Notice kind="warn">Нет в базе (или признак счёта неоднозначен): …{state.missingAccounts!.join(', …')}. По ним сравнения не было, «В базе» пусто.</Notice>
        )}
        {!closed && problems > 0 && <Notice kind="warn">Проблем: {problems}. Откройте «Проблемы».</Notice>}
        {!closed && problems > 0 && <button className="btn primary" disabled={busy} onClick={() => go('statementProblems', { accountId: task.id })}>Проблемы ({problems})</button>}
        <button className="btn" disabled={busy} onClick={() => void downloadOps()}>{compared ? 'Сравнить заново и скачать файл' : 'Сравнить с базой и скачать файл'}</button>
      </Step>
      <Step title="Шаг 5. Сверка остатков и запись" summary={s5sum} status={s5} open={isOpen(5, s5)} onToggle={() => toggle(5, s5)}>
        {closed && <Notice kind="ok">Задача закрыта{state.writtenCount !== undefined ? `, записано операций: ${state.writtenCount}` : ''}. Задачу можно удалить, записанные данные останутся.</Notice>}
        {ready && bal.loading && <p className="muted">Считаю остатки…</p>}
        {ready && bal.error && <ErrorBox text={bal.error} onRetry={bal.reload} />}
        {ready && bal.data && (
          <>
            {bal.data.items.map((i) => (
              <div key={i.accountKey}>
                <p>…{i.accountKey} {i.accountName} ({i.periodStart} — {i.periodEnd})</p>
                <p className="muted">Начало: в базе {formatMinor(i.startDbMinor, 2)}, в выписке {formatMinor(i.startStmtMinor, 2)} {i.startOk ? '✓' : '✗'}</p>
                <p className="muted">Конец: в базе после записи {formatMinor(i.endExpectedMinor, 2)}, в выписке {formatMinor(i.endStmtMinor, 2)} {i.endOk ? '✓' : '✗'} {i.currency}</p>
                {!i.startOk && (() => {
                  const p = fixes.data?.plans.find((x) => x.accountKey === i.accountKey)
                  const b = fixes.data?.blocked.find((x) => x.accountKey === i.accountKey)
                  if (p) return (
                    <>
                      <p className="muted">{p.kind === 'create'
                        ? `Нет начального остатка. Будет создан: ${formatMinor(p.openingMinor, 2)} ${i.currency} на начало периода.`
                        : `Есть более поздний начальный остаток ${formatMinor(p.oldOpeningMinor ?? 0, 2)}. Новый ${formatMinor(p.openingMinor, 2)} встанет на начало периода; прежний ${p.gapMinor === 0 ? 'удалится (движения его объясняют)' : `станет корректировкой на ${formatMinor(p.gapMinor ?? 0, 2)} (неучтённая разница)`}.`}</p>
                      <button className="btn primary" disabled={busy} onClick={() => void applyFix(i.accountKey)}>{p.kind === 'create' ? 'Создать начальный остаток' : 'Передвинуть начальный остаток'}</button>
                    </>
                  )
                  if (b) return <p className="muted">Начальный остаток не предлагается: {b.reason}.</p>
                  return fixes.data ? <p className="muted">До начала периода в базе уже есть записи: остаток не сходится из-за пропуска или дубля. Проверьте предыдущие выписки.</p> : null
                })()}
              </div>
            ))}
            {bal.data.ok
              ? <Notice kind="ok">Остатки сходятся.</Notice>
              : <Notice kind="warn">Остатки не сходятся. Запись заблокирована.</Notice>}
            {bal.data.ok && bal.data.newCount === 0 && <Notice kind="ok">Операции уже записаны в базе, новых записей: 0.</Notice>}
            <button className="btn" disabled={busy} onClick={() => bal.reload()}>Проверить остатки ещё раз</button>
            <button className="btn primary" disabled={busy || !bal.data.ok} onClick={() => void finish()}>{bal.data.newCount === 0 ? 'Закрыть задачу' : `Записать (${bal.data.newCount})`}</button>
          </>
        )}
      </Step>
      {busy && <p className="muted">Подождите…</p>}
      {msg && <Notice kind={msg.kind === 'ok' ? 'ok' : 'warn'}>{msg.text}</Notice>}
      <button className="btn" disabled={busy} onClick={() => void remove()}>Удалить задачу</button>
    </>
  )
}
