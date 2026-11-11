import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { commitBalanceEntry, previewBalanceEntry, type BalanceEntryPreview } from '../../core'
import { useApp } from '../app'
import { dateTimeRu, errorText, localInputToIso, parseAmountInput, toLocalInput } from '../format'
import { BackButton, Notice, Screen, useCurrencyFormat } from '../parts'

export function BalanceScreen({ initialAccountId }: { initialAccountId?: string }) {
  const { ctx, ref, bump } = useApp()
  const { fmt, dec, code } = useCurrencyFormat()
  const accounts = ref.accounts.filter((a) => !a.archivedAt)
  const [accountId, setAccountId] = useState(accounts.some((a) => a.id === initialAccountId) ? initialAccountId! : accounts[0]?.id ?? '')
  const [when, setWhen] = useState(toLocalInput())
  const [text, setText] = useState('')
  const [adj, setAdj] = useState(true)
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [preview, setPreview] = useState<BalanceEntryPreview | null>(null)
  const [previewError, setPreviewError] = useState<string | null>(null)
  const [refresh, setRefresh] = useState(0)

  const account = accounts.find((a) => a.id === accountId) ?? null
  const decimals = account ? dec(account.currencyKey) : 2
  const parsed = useMemo(() => parseAmountInput(text, decimals), [text, decimals])
  const asOf = useMemo(() => localInputToIso(when), [when])

  // Прошлый и расчётный остаток не зависят от вводимой суммы: читаем один раз на счёт и момент.
  useEffect(() => {
    if (!account || !asOf) { setPreview(null); return }
    let dead = false
    setPreviewError(null)
    previewBalanceEntry(ctx, { accountId: account.id, asOf, newBalanceMinor: 0 }).then(
      (p) => { if (!dead) setPreview(p) },
      (e) => { if (!dead) { setPreview(null); setPreviewError(errorText(e)) } },
    )
    return () => { dead = true }
  }, [ctx, account, asOf, refresh])

  const valid = parsed !== null && 'minor' in parsed
  const newMinor = valid ? parsed.minor : null
  const diff = preview && newMinor !== null ? newMinor - preview.calculatedMinor : null
  const onlyBalances = account?.trackingMode === 'balance_only'
  const opening = preview?.willBeOpening ?? false
  const canChooseAdjustment = !onlyBalances && !opening && diff !== null && diff !== 0

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (!account || !asOf || newMinor === null) return
    setBusy(true); setError(null); setResult(null)
    try {
      const r = await commitBalanceEntry(ctx, {
        accountId: account.id, asOf, newBalanceMinor: newMinor,
        createAdjustment: opening ? true : adj, note: note.trim() || null,
      })
      setResult(r.adjustment
        ? `Сохранено: остаток ${fmt(newMinor, account.currencyKey)}, корректировка ${fmt(r.adjustment.amountMinor, account.currencyKey)}${r.adjustment.isOpening ? ' (стартовый остаток)' : ''}.`
        : `Сохранено: остаток ${fmt(newMinor, account.currencyKey)}, расчёт сходится.`)
      setText(''); setNote(''); setRefresh((n) => n + 1); bump()
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  if (accounts.length === 0) {
    return <Screen title="Ввод остатка" back={<BackButton to="home" />}><Notice kind="info">Нет открытых счетов.</Notice></Screen>
  }

  return (
    <Screen title="Ввод остатка" back={<BackButton to="home" />}>
      <form onSubmit={submit} className="form">
        <label>Счёт
          <select value={accountId} onChange={(e) => { setAccountId(e.target.value); setResult(null); setError(null) }}>
            {ref.projects.map((p) => (
              <optgroup key={p.id} label={p.name}>
                {accounts.filter((a) => a.projectId === p.id).map((a) => <option key={a.id} value={a.id}>{a.name} · {code(a.currencyKey)}</option>)}
              </optgroup>
            ))}
          </select>
        </label>
        <label>Дата и время
          <input type="datetime-local" value={when} onChange={(e) => { setWhen(e.target.value); setResult(null) }} required />
        </label>

        {previewError && <div className="box error" role="alert">{previewError}</div>}
        {preview && account && (
          <div className="card facts">
            <div><span>Прошлый остаток</span>
              <b>{preview.previousMinor === null ? 'нет' : `${fmt(preview.previousMinor, account.currencyKey)}`}</b></div>
            {preview.previousAsOf && <div className="row-sub">зафиксирован {dateTimeRu(preview.previousAsOf)}</div>}
            <div><span>Расчётный остаток</span><b>{fmt(preview.calculatedMinor, account.currencyKey)}</b></div>
          </div>
        )}

        <label>Новый остаток{account ? `, ${code(account.currencyKey)}` : ''}
          <input inputMode="decimal" autoComplete="off" placeholder="0,00" value={text}
            onChange={(e) => { setText(e.target.value); setResult(null) }} />
        </label>
        {parsed && 'error' in parsed && <p className="warn-text">{parsed.error}</p>}

        {diff !== null && account && (
          <div className={`card facts${diff === 0 ? '' : ' warn'}`}>
            <div><span>Разница с расчётом</span><b>{diff === 0 ? 'сходится' : fmt(diff, account.currencyKey)}</b></div>
          </div>
        )}
        {opening && <Notice kind="info">У счёта ещё нет записей: этот остаток станет стартовым.</Notice>}
        {onlyBalances && !opening && <Notice kind="info">Счёт ведётся только по остаткам: корректировка на разницу создаётся сразу.</Notice>}
        {canChooseAdjustment && (
          <label className="check">
            <input type="checkbox" checked={adj} onChange={(e) => setAdj(e.target.checked)} />
            Создать корректировку на разницу (попадёт в «неучтённое»)
          </label>
        )}
        {canChooseAdjustment && !adj && (
          <Notice>Без корректировки сохранится только контрольная точка, и срез покажет расхождение.</Notice>
        )}

        <label>Примечание (необязательно)
          <input value={note} onChange={(e) => setNote(e.target.value)} />
        </label>

        {error && <div className="box error" role="alert">{error}</div>}
        {result && <div className="box ok" role="status">{result}</div>}
        <button className="btn primary" disabled={busy || !valid || !asOf || !account}>{busy ? 'Сохраняем…' : 'Сохранить остаток'}</button>
      </form>
    </Screen>
  )
}
