import { useMemo, useState, type FormEvent } from 'react'
import { lastEnteredBalances, saveEnteredBalance } from '../../core'
import type { Account } from '../../data/types'
import { useApp } from '../app'
import { dateRu, errorText, parseAmountInput, todayLocal } from '../format'
import { useLoad } from '../hooks'
import { AccountChip, BackButton, ErrorBox, Loading, Notice, Screen, useCurrencyFormat } from '../parts'

function EnterRow({ account, last, onSaved }: { account: Account; last: { date: string; minor: number } | null; onSaved: () => void }) {
  const { ctx, bump } = useApp()
  const { fmt, dec, code } = useCurrencyFormat()
  const [date, setDate] = useState(todayLocal())
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [ok, setOk] = useState<string | null>(null)
  const parsed = useMemo(() => parseAmountInput(text, dec(account.currencyKey)), [text, account.currencyKey]) // eslint-disable-line react-hooks/exhaustive-deps
  const valid = parsed !== null && 'minor' in parsed

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (!valid || !date) return
    setBusy(true); setError(null); setOk(null)
    try {
      await saveEnteredBalance(ctx, { accountId: account.id, date, balanceMinor: parsed.minor })
      setOk(`Сохранено: ${fmt(parsed.minor, account.currencyKey)} на ${dateRu(date)}`)
      setText(''); bump(); onSaved()
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <li className="card" style={{ listStyle: 'none', marginBottom: 8 }}>
      <div className="row" style={{ padding: 0 }}>
        <AccountChip account={account} />
        <div className="row-main grow">
          <span className="row-title">{account.name} · {code(account.currencyKey)}</span>
          <span className="row-sub">{last ? `${dateRu(last.date)}: ${fmt(last.minor, account.currencyKey)}` : 'нет данных'}</span>
        </div>
      </div>
      <form onSubmit={submit} className="form" style={{ marginTop: 8 }}>
        <label>Дата <input type="date" value={date} max="2999-12-31" onChange={(e) => { setDate(e.target.value); setOk(null) }} required /></label>
        <label>Остаток, {code(account.currencyKey)}
          <input inputMode="decimal" autoComplete="off" placeholder="0,00" value={text} onChange={(e) => { setText(e.target.value); setOk(null) }} />
        </label>
        {parsed && 'error' in parsed && <p className="warn-text">{parsed.error}</p>}
        {error && <div className="box error" role="alert">{error}</div>}
        {ok && <div className="box ok" role="status">{ok}</div>}
        <button className="btn primary" disabled={busy || !valid || !date}>{busy ? 'Сохраняем…' : 'Сохранить'}</button>
      </form>
    </li>
  )
}

export function EnterBalancesScreen() {
  const { ctx, ref } = useApp()
  const accounts = ref.accounts.filter((a) => !a.archivedAt)
  const q = useLoad(() => lastEnteredBalances(ctx), [])
  return (
    <Screen title="Ввод остатков" back={<BackButton to="more" />}>
      {q.loading && !q.data && <Loading />}
      {q.error && <ErrorBox text={q.error} onRetry={q.reload} />}
      {q.data && (
        <>
          <Notice kind="info">Сохраняется только остаток на дату. Движения и корректировки не создаются. Счета можно вводить по очереди.</Notice>
          {ref.projects.map((p) => {
            const list = accounts.filter((a) => a.projectId === p.id)
            if (list.length === 0) return null
            return (
              <div key={p.id} className="group">
                <div className="group-head"><h2>{p.name}</h2></div>
                <ul className="plain">
                  {list.map((a) => {
                    const c = q.data!.get(a.id)
                    return <EnterRow key={a.id} account={a} last={c ? { date: c.date, minor: c.balanceMinor } : null} onSaved={q.reload} />
                  })}
                </ul>
              </div>
            )
          })}
        </>
      )}
    </Screen>
  )
}
