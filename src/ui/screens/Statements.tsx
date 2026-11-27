// Выписки: список задач, новая загрузка (шаг 1), страница задачи (шаги 2 и далее). Задачи хранятся в базе.
import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { createStatementTask, saveStatementFromTask, buildStatementAccountIntoLedger, removeStatementAccountFromLedger, deleteStatementDocument, buildDocumentWorkbook, documentFileName, deleteStatementTask, formatMinor, listStatementTasks, listTaskProblems, recordCounterpartyUpload, resolveProblem, taskAccountsStatus, identifyStatementAccount, confirmAccountsRecognized, confirmCounterpartiesRecognized, taskStatement, updateTaskState } from '../../core'
import type { ProblemAction, ProblemDetails } from '../../core'
import {
  applyCounterpartyFile, buildCounterpartyWorkbook, counterpartyStatus, extractPdfPages, parseSlspStatement, readCounterpartyWorkbook, reconcileAccount,
} from '../../core/statements'
import type { StatementTaskState } from '../../core'
import type { Account, StatementDocAccount, StatementDocRow, StatementDocument, StatementTask } from '../../data/types'
import { useApp } from '../app'
import { useLoad } from '../hooks'
import { dateRu, dateTimeRu, errorText } from '../format'
import { BackButton, ErrorBox, Loading, Notice, Screen } from '../parts'

const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
type Msg = { kind: 'ok' | 'error'; text: string } | null
interface Picked { name: string; bytes: Uint8Array }

/** Отдаёт файл: через «Поделиться» (если разрешено), иначе обычным скачиванием. Возвращает ссылку для ручного сохранения: автоскачивание после долгой сборки файла браузер иногда молча блокирует. */
async function saveFile(name: string, bytes: Uint8Array, type: string): Promise<string | null> {
  const file = new File([bytes as BlobPart], name, { type })
  if (navigator.canShare?.({ files: [file] })) {
    try { await navigator.share({ files: [file], title: name }); return null } catch (e) { if ((e as Error).name === 'AbortError') return null }
  }
  const url = URL.createObjectURL(file)
  const a = document.createElement('a')
  a.href = url; a.download = name
  document.body.appendChild(a); a.click(); a.remove()
  return url
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
      {tasks.data && tasks.data.length > 0 && <h3>Загрузки</h3>}
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
      <DocumentsList />
    </Screen>
  )
}

const BANK_RU: Record<string, string> = { slsp: 'Slovenská sporiteľňa' }

/** Сохранённые выписки (документы): аккордеон; раскрытие: раскладка по счетам, скачать XLSX, удалить. */
function DocumentsList() {
  const { ctx } = useApp()
  const data = useLoad(async () => {
    const s = ctx.storage
    const [documents, accounts, rows, dbAccs] = await Promise.all([s.list('statementDocuments'), s.list('statementAccounts'), s.list('statementRows'), s.list('accounts')])
    return { documents: [...documents].sort((a, b) => b.createdAt.localeCompare(a.createdAt)), accounts, rows, dbAccs }
  }, [])
  return (
    <>
      <h3>Сохранённые выписки</h3>
      {data.loading && <Loading />}
      {data.error && <ErrorBox text={data.error} onRetry={data.reload} />}
      {data.data && data.data.documents.length === 0 && <p className="muted">Сохранённых выписок пока нет.</p>}
      {data.data && data.data.documents.map((d) => (
        <DocCard key={d.id} doc={d} accs={data.data!.accounts.filter((a) => a.documentId === d.id)} rows={data.data!.rows.filter((r) => r.documentId === d.id)}
          dbAccs={data.data!.dbAccs} onChanged={data.reload} />
      ))}
    </>
  )
}

function DocCard({ doc, accs, rows, dbAccs, onChanged }: {
  doc: StatementDocument; accs: StatementDocAccount[]; rows: StatementDocRow[]; dbAccs: Account[]; onChanged: () => void
}) {
  const { ctx, bump } = useApp()
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<Msg>(null)
  const [dl, setDl] = useState<{ name: string; url: string } | null>(null)
  const bank = BANK_RU[doc.bank] ?? doc.bank
  const short = (d: string) => `${d.slice(8, 10)}.${d.slice(5, 7)}.${d.slice(2, 4)}`
  const period = doc.periodStart && doc.periodEnd ? `${short(doc.periodStart)}–${short(doc.periodEnd)}` : short(doc.createdAt.slice(0, 10))
  const builtIn = accs.filter((a) => a.builtInAt).length
  const sub = `${accs.length === 1 ? '1 счёт' : `${accs.length} счетов`} · строк ${rows.length}${rows.some((r) => r.duplicateOf) ? ` · дублей ${rows.filter((r) => r.duplicateOf).length}` : ''} · ${builtIn === accs.length ? 'встроена' : builtIn === 0 ? 'не встроена' : 'встроена частично'}`
  async function download() {
    setBusy(true); setMsg(null)
    try {
      const name = documentFileName(doc)
      if (dl) URL.revokeObjectURL(dl.url)
      const url = await saveFile(name, await buildDocumentWorkbook(ctx, doc.id), XLSX)
      setDl(url ? { name, url } : null)
    } catch (e) { setMsg({ kind: 'error', text: errorText(e) }) } finally { setBusy(false) }
  }
  async function ledger(a: StatementDocAccount) {
    setBusy(true); setMsg(null)
    try {
      if (a.builtInAt) {
        if (!window.confirm('Убрать эту часть выписки из учёта? Её операции будут удалены (парные записи переводов тоже, если они созданы только из неё).')) { setBusy(false); return }
        const r = await removeStatementAccountFromLedger(ctx, a.id)
        setMsg({ kind: 'ok', text: `Убрано из учёта операций: ${r.removed}.` })
      } else {
        const r = await buildStatementAccountIntoLedger(ctx, a.id)
        setMsg({ kind: 'ok', text: `Встроено в учёт: создано операций ${r.created}${r.adopted ? `, привязано к существующим переводам ${r.adopted}` : ''}${r.unpaired ? `, переводов без пары ${r.unpaired}` : ''}.` })
      }
      bump(); onChanged()
    } catch (e) { setMsg({ kind: 'error', text: errorText(e) }) } finally { setBusy(false) }
  }
  async function remove() {
    if (!window.confirm('Удалить выписку? Контрагенты и теги останутся. Встроенную в учёт выписку сначала нужно убрать из учёта.')) return
    setBusy(true); setMsg(null)
    try { await deleteStatementDocument(ctx, doc.id); bump(); onChanged() } catch (e) { setMsg({ kind: 'error', text: errorText(e) }); setBusy(false) }
  }
  return (
    <div className="acc doc">
      <div className="acc-head">
        <button type="button" className="acc-main" onClick={() => setOpen(!open)} aria-expanded={open}>
          <span className="acc-text"><span className="acc-title">{bank} <span className="acc-date">{period}</span></span><span className="acc-sum">{sub}</span></span>
          <span className="acc-chev">{open ? '▾' : '▸'}</span>
        </button>
      </div>
      {open && (
        <div className="acc-body">
          {accs.map((a) => {
            const acc = dbAccs.find((x) => x.id === a.accountId)
            const cur = acc?.currencyKey.toUpperCase() ?? ''
            const n = rows.filter((r) => r.statementAccountId === a.id)
            return (
              <div key={a.id}>
                <p><b>{acc?.name ?? 'Счёт'}</b>{a.periodStart && a.periodEnd ? ` · ${dateRu(a.periodStart)} — ${dateRu(a.periodEnd)}` : ''}</p>
                {a.openingMinor !== null && a.closingMinor !== null && <p className="muted">Остаток: {formatMinor(a.openingMinor, 2)} → {formatMinor(a.closingMinor, 2)} {cur}</p>}
                {a.incomeMinor !== null && a.expenseMinor !== null && <p className="muted">Приход: {formatMinor(a.incomeMinor, 2)} · Расход: {formatMinor(a.expenseMinor, 2)} {cur}</p>}
                <p className="muted">Строк: {n.length}{n.some((r) => r.duplicateOf) ? `, дублей: ${n.filter((r) => r.duplicateOf).length}` : ''} · {a.builtInAt ? 'встроена в учёт' : 'не встроена в учёт'}</p>
                <button className={a.builtInAt ? 'btn' : 'btn primary'} disabled={busy || !ctx.actor.isOwner} onClick={() => void ledger(a)}>{a.builtInAt ? 'Убрать из учёта' : 'Встроить в учёт'}</button>
              </div>
            )
          })}
          <button className="btn" disabled={busy} onClick={() => void download()}>Скачать Excel</button>
          {dl && <a className="btn" href={dl.url} download={dl.name}>Файл не скачался? Нажмите, чтобы сохранить: {dl.name}</a>}
          <button className="btn" disabled={busy || !ctx.actor.isOwner} onClick={() => void remove()}>Удалить выписку</button>
          {msg && <Notice kind={msg.kind === 'ok' ? 'ok' : 'warn'}>{msg.text}</Notice>}
        </div>
      )}
    </div>
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
  const [dl, setDl] = useState<{ step: number; name: string; url: string } | null>(null)
  const deliver = async (step: number, name: string, bytes: Uint8Array) => {
    if (dl) URL.revokeObjectURL(dl.url)
    const url = await saveFile(name, bytes, XLSX)
    setDl(url ? { step, name, url } : null)
  }
  const dlLink = (step: number) => (dl && dl.step === step
    ? <a className="btn" href={dl.url} download={dl.name}>Файл не скачался? Нажмите, чтобы сохранить: {dl.name}</a> : null)
  const auto = useRef<Set<string>>(new Set())
  const st = taskStatement(task)
  const state = task.state as StatementTaskState
  const accs = useLoad(() => taskAccountsStatus(ctx, task.id), [task.id, task.updatedAt])
  const allAccountsKnown = !!accs.data && accs.data.length > 0 && accs.data.every((x) => x.account)
  const accountsPassed = !!state.accountsConfirmed || !!state.counterpartiesLoaded
  const cps = useLoad(() => counterpartyStatus(ctx, st), [task.id, task.updatedAt])
  const allKnown = !!cps.data && cps.data.unrecognized.length === 0
  const closed = !!state.operationsDone

  async function run(fn: () => Promise<string>) {
    setBusy(true); setMsg(null)
    try { setMsg({ kind: 'ok', text: await fn() }); reload() } catch (e) { setMsg({ kind: 'error', text: errorText(e) }) } finally { setBusy(false) }
  }

  // Автопереходы: счета опознаны → шаг 3; контрагенты опознаны → шаг 4 («Сохранить выписку»).
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
  }, [busy, closed, task.status, accountsPassed, allAccountsKnown, allKnown, state.counterpartiesLoaded, ctx, task.id, bump, reload])

  const download = () => run(async () => {
    const a = st.accounts[0]!
    const name = `kontragenty_${a.periodEnd.slice(0, 7)}.xlsx`
    await deliver(3, name, await buildCounterpartyWorkbook(ctx, st))
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
  const save = () => run(async () => {
    const r = await saveStatementFromTask(ctx, task.id); bump()
    return r.duplicates > 0 ? `Выписка сохранена: строк ${r.rows}, из них дублей ${r.duplicates} (помечены).` : `Выписка сохранена: строк ${r.rows}.`
  })
  async function remove() {
    if (!window.confirm('Удалить задачу? Разобранные данные будут стёрты. Сохранённые выписки и контрагенты останутся.')) return
    setBusy(true)
    try { await deleteStatementTask(ctx, task.id); bump(); go('statements') } catch (e) { setMsg({ kind: 'error', text: errorText(e) }); setBusy(false) }
  }

  const s2: StepStatus = accountsPassed ? 'done' : 'current'
  const s3: StepStatus = state.counterpartiesLoaded ? 'done' : accountsPassed ? 'current' : 'future'
  const s4: StepStatus = closed ? 'done' : state.counterpartiesLoaded ? 'current' : 'future'
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
  const s4sum = s4 === 'future' ? 'Ожидает шага 3'
    : closed
      ? (state.documentId ? `Сохранена: строк ${state.savedRows ?? 0}${state.savedDuplicates ? `, дублей ${state.savedDuplicates}` : ''}` : `Задача закрыта, записано операций: ${state.writtenCount ?? 0}`)
      : 'Готово к сохранению'

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
        {dlLink(3)}
        <input type="file" accept=".xlsx" disabled={busy}
          onChange={(e) => { setMsg(null); void readPicked(e.target.files?.[0]).then(setXlsx).catch((x) => setMsg({ kind: 'error', text: errorText(x) })) }} />
        {xlsx && <p className="muted">Выбран: {xlsx.name}</p>}
        <button className="btn primary" disabled={busy || !xlsx} onClick={() => void upload()}>Загрузить правленый файл</button>
      </Step>
      <Step title="Шаг 4. Сохранить выписку" summary={s4sum} status={s4} open={isOpen(4, s4)} onToggle={() => toggle(4, s4)}
        info="Выписка сохраняется документом: период, остаток на начало и конец по каждому счёту и строки. Операции в учёт не записываются: это делает отдельная процедура встраивания. Если какие-то строки уже есть в ранее сохранённых выписках, они помечаются как дубли. Если все строки уже есть, выписка не сохраняется. Сохранённые выписки смотрите на экране «Выписки».">
        {closed
          ? <Notice kind="ok">{state.documentId ? 'Выписка сохранена. Смотрите её в списке «Выписки».' : 'Задача закрыта.'}</Notice>
          : <button className="btn primary" disabled={busy || !recs.every((r) => r.ok)} onClick={() => void save()}>Сохранить выписку</button>}
        {closed && <button className="btn" disabled={busy} onClick={() => go('statements')}>К списку выписок</button>}
      </Step>
      {busy && <p className="muted">Подождите…</p>}
      {msg && <Notice kind={msg.kind === 'ok' ? 'ok' : 'warn'}>{msg.text}</Notice>}
      <button className="btn" disabled={busy} onClick={() => void remove()}>Удалить задачу</button>
    </>
  )
}
