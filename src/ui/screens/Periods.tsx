import { useState } from 'react'
import {
  closePeriod, currentLock, endOfLocalDayMs, getCheckpointDiffs, iso, reopenPeriod, resolveTimeZone,
  type CheckpointDiff,
} from '../../core'
import type { PeriodLock } from '../../data/types'
import { useApp } from '../app'
import { useLoad } from '../hooks'
import { dateRu, dateTimeRu, errorText, lastDayOfPreviousMonth } from '../format'
import { BackButton, DiffList, ErrorBox, Loading, Notice, Screen } from '../parts'

export function PeriodsScreen() {
  const { ctx } = useApp()
  const locks = useLoad(() => ctx.storage.listPeriodLocks(), [])
  return (
    <Screen title="Закрытие периодов" back={<BackButton to="more" label="Ещё" />}>
      {!ctx.actor.isOwner && <Notice>Закрывать и открывать периоды может только владелец.</Notice>}
      {locks.loading && <Loading />}
      {locks.error && <ErrorBox text={locks.error} onRetry={locks.reload} />}
      {locks.data && <GlobalPeriods locks={locks.data} onChanged={locks.reload} />}
    </Screen>
  )
}

interface Check { diffs: CheckpointDiff[]; deleted: number }

function GlobalPeriods({ locks, onChanged }: { locks: PeriodLock[]; onChanged: () => void }) {
  const { ctx, ref, bump } = useApp()
  const cur = currentLock(locks)
  const active = locks.filter((l) => l.status === 'active').sort((a, b) => b.seq - a.seq)
  const [mode, setMode] = useState<'none' | 'close' | 'reopen' | 'history'>('none')
  const [through, setThrough] = useState(lastDayOfPreviousMonth())
  const [check, setCheck] = useState<Check | null>(null)
  const [purge, setPurge] = useState(false)
  const [allowMismatch, setAllowMismatch] = useState(false)
  const [steps, setSteps] = useState(1)
  const [reason, setReason] = useState('')
  const [sure, setSure] = useState(false)
  const [word, setWord] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)

  const accounts = ref.accounts
  const accName = (id: string) => ref.accounts.find((a) => a.id === id)?.name ?? id

  function open(m: typeof mode) {
    setMode(m); setError(null); setDone(null); setCheck(null); setAllowMismatch(false)
    setSure(false); setWord(''); setReason(''); setSteps(1)
  }

  async function runCheck() {
    setBusy(true); setError(null); setCheck(null)
    try {
      const diffs = (await getCheckpointDiffs(ctx, { accountIds: accounts.map((a) => a.id), throughDate: through })).filter((d) => d.diffMinor !== 0)
      let deleted = 0
      for (const a of accounts) {
        const tz = resolveTimeZone(a, ref.countries, ref.settings)
        deleted += (await ctx.storage.listTransactions({ accountId: a.id, deletedOnly: true, bookedTo: iso(endOfLocalDayMs(through, tz)) })).length
      }
      setCheck({ diffs, deleted })
    } catch (e) { setError(errorText(e)) } finally { setBusy(false) }
  }

  async function doClose() {
    if (!check) return
    if (!window.confirm(`Закрыть период по ${dateRu(through)} для всех счетов? Записи до этой даты станут недоступны для правки.`)) return
    setBusy(true); setError(null)
    try {
      const r = await closePeriod(ctx, { through, purgeDeleted: purge, allowMismatch })
      setDone(`Период закрыт по ${dateRu(through)}. Удалено насовсем: ${r.purged}, очищено исходных данных выписок: ${r.rawCleared}.`)
      setMode('none'); bump(); onChanged()
    } catch (e) { setError(errorText(e)) } finally { setBusy(false) }
  }

  async function doReopen() {
    if (!window.confirm('Открыть период? Записи за него снова можно будет менять. Действие попадёт в журнал.')) return
    setBusy(true); setError(null)
    try {
      const r = await reopenPeriod(ctx, { steps, reason })
      setDone(r.lockedThrough ? `Период открыт. Теперь закрыт по ${dateRu(r.lockedThrough)}.` : 'Период открыт полностью.')
      setMode('none'); bump(); onChanged()
    } catch (e) { setError(errorText(e)) } finally { setBusy(false) }
  }

  const deep = steps > 1
  const reopenReady = reason.trim() !== '' && sure && (!deep || word.trim().toUpperCase() === 'ОТКРЫТЬ')
  const closeBlocked = !check || (check.diffs.length > 0 && !allowMismatch)

  return (
    <div className="card">
      <h2>Все счета</h2>
      <p className="muted">Закрытие общее: за период всё сведено и остатки точные.</p>
      <p>{cur ? <>Закрыт по <b>{dateRu(cur.lockedThrough)}</b></> : 'Не закрыт'}</p>
      {done && <div className="box ok" role="status">{done}</div>}
      {ctx.actor.isOwner && (
        <div className="actions">
          <button className="btn small" onClick={() => open('close')}>Закрыть период</button>
          {cur && <button className="btn small" onClick={() => open('reopen')}>Открыть</button>}
          {locks.length > 0 && <button className="btn small" onClick={() => open(mode === 'history' ? 'none' : 'history')}>История</button>}
        </div>
      )}

      {mode === 'close' && (
        <div className="form">
          <label>Закрыть по дату (включительно)
            <input type="date" value={through} onChange={(e) => { setThrough(e.target.value); setCheck(null); setAllowMismatch(false) }} />
          </label>
          <button className="btn" disabled={busy || !through} onClick={runCheck}>{busy && !check ? 'Проверяем…' : 'Проверить сверку'}</button>
          {check && (
            <>
              {check.diffs.length === 0
                ? <Notice kind="ok">Остатки сходятся с контрольными точками.</Notice>
                : (
                  <Notice>
                    <b>Расхождений: {check.diffs.length}</b>
                    <DiffList diffs={check.diffs} accountName={accName} />
                    <label className="check">
                      <input type="checkbox" checked={allowMismatch} onChange={(e) => setAllowMismatch(e.target.checked)} />
                      Закрыть несмотря на расхождения
                    </label>
                  </Notice>
                )}
              {check.deleted > 0 && (
                <Notice kind="info">
                  Помеченных на удаление записей: {check.deleted}.
                  <label className="check"><input type="radio" checked={!purge} onChange={() => setPurge(false)} />Оставить помеченными</label>
                  <label className="check"><input type="radio" checked={purge} onChange={() => setPurge(true)} />Удалить насовсем</label>
                </Notice>
              )}
              <button className="btn primary" disabled={busy || closeBlocked} onClick={doClose}>Закрыть период</button>
            </>
          )}
        </div>
      )}

      {mode === 'reopen' && cur && (
        <div className="form">
          <Notice>Открытие снимает блокировку правок. Записи в журнал попадут причина и дата.</Notice>
          <label>На сколько шагов назад
            <select value={steps} onChange={(e) => { setSteps(Number(e.target.value)); setSure(false); setWord('') }}>
              {active.map((_, i) => (
                <option key={i} value={i + 1}>
                  {i + 1}: {active[i + 1] ? `до ${dateRu(active[i + 1]!.lockedThrough)}` : 'полностью открыть'}
                </option>
              ))}
            </select>
          </label>
          <label>Причина
            <input value={reason} onChange={(e) => setReason(e.target.value)} />
          </label>
          <label className="check"><input type="checkbox" checked={sure} onChange={(e) => setSure(e.target.checked)} />Понимаю последствия</label>
          {deep && (
            <label>Открытие глубже предыдущей точки. Введите слово ОТКРЫТЬ
              <input value={word} onChange={(e) => setWord(e.target.value)} />
            </label>
          )}
          <button className="btn danger" disabled={busy || !reopenReady} onClick={doReopen}>Открыть период</button>
        </div>
      )}

      {mode === 'history' && (
        <ul className="plain">
          {[...locks].sort((a, b) => b.seq - a.seq).map((l) => (
            <li key={l.id} className="row">
              <div className="row-main">
                <span className="row-title">до {dateRu(l.lockedThrough)}</span>
                <span className="row-sub">закрыт {dateTimeRu(l.lockedAt)}</span>
                {l.status === 'released' && <span className="row-sub">открыт {l.releasedAt ? dateTimeRu(l.releasedAt) : ''}{l.releaseReason ? `: ${l.releaseReason}` : ''}</span>}
              </div>
              <span className="row-sub">{l.status === 'active' ? 'действует' : 'снято'}</span>
            </li>
          ))}
        </ul>
      )}
      {error && <div className="box error" role="alert">{error}</div>}
    </div>
  )
}
