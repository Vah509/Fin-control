import { useState } from 'react'
import { getSnapshot, moveAccount, resolveAppearance, setAccountArchived, updateAccount, writeAppearance, type ColorKey, type IconKey } from '../../core'
import { useApp } from '../app'
import { useLoad } from '../hooks'
import { errorText, todayLocal } from '../format'
import { AccountChip, AppearancePicker, BackButton, Notice, Screen, TYPE_LABELS, useCurrencyFormat } from '../parts'

/** Карточка счёта: остаток, ввод остатка, архив. Карандаш открывает полную правку (название, раздел, цвет, иконка). */
export function AccountScreen({ accountId }: { accountId: string }) {
  const { ctx, ref, go, bump, reloadRef } = useApp()
  const { code, fmt } = useCurrencyFormat()
  const today = todayLocal()
  const snap = useLoad(() => getSnapshot(ctx, { date: today }), [today])
  const account = ref.accounts.find((a) => a.id === accountId)
  const start = account ? resolveAppearance(account.appearance, account.id, account.type) : null
  const [editing, setEditing] = useState(false)
  const [name, setName] = useState(account?.name ?? '')
  const [color, setColor] = useState<ColorKey>(start?.color ?? 'blue')
  const [icon, setIcon] = useState<IconKey>(start?.icon ?? 'bank')
  const [projectId, setProjectId] = useState(account?.projectId ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)

  if (!account) {
    return <Screen title="Счёт" back={<BackButton to="accounts" label="Счета" />}><Notice kind="info">Счёт не найден.</Notice></Screen>
  }
  const institution = ref.institutions.find((i) => i.id === account.institutionId)?.name
  const country = ref.countries.find((c) => c.key === account.countryKey)?.name ?? account.countryKey
  const row = snap.data?.rows.find((r) => r.accountId === account.id)
  const base = snap.data?.totals.baseCurrency ?? ''

  async function run(fn: () => Promise<void>, ok: string) {
    setBusy(true); setError(null); setDone(null)
    try { await fn(); await reloadRef(); bump(); setDone(ok); return true } catch (e) { setError(errorText(e)); return false } finally { setBusy(false) }
  }

  function startEdit() {
    const a = resolveAppearance(account!.appearance, account!.id, account!.type)
    setName(account!.name); setColor(a.color); setIcon(a.icon); setProjectId(account!.projectId)
    setError(null); setDone(null); setEditing(true)
  }

  const save = async () => {
    const ok = await run(async () => {
      const acc = account!
      await updateAccount(ctx, acc.id, { name: name.trim(), appearance: writeAppearance(acc.appearance, { color, icon }) })
      if (projectId !== acc.projectId) await moveAccount(ctx, acc.id, projectId)
    }, 'Сохранено.')
    if (ok) setEditing(false)
  }

  const toggleArchive = () => run(async () => { await setAccountArchived(ctx, account.id, !account.archivedAt) },
    account.archivedAt ? 'Счёт возвращён из архива.' : 'Счёт в архиве: в срезах прошлых дат он остаётся.')

  return (
    <Screen title="Счёт" back={<BackButton to="accounts" label="Счета" />}>
      <div className="card account-head">
        <AccountChip account={account} color={editing ? color : undefined} icon={editing ? icon : undefined} size={52} />
        <div className="grow">
          <b>{editing ? (name.trim() || account.name) : account.name}</b>
          <div className="row-sub">{TYPE_LABELS[account.type]} · {code(account.currencyKey)} · {country}{institution ? ` · ${institution}` : ''}</div>
          {account.archivedAt && <div className="row-sub warn-text">В архиве</div>}
        </div>
        {!editing && <button className="btn small" aria-label="Редактировать счёт" onClick={startEdit}>✎</button>}
      </div>

      {error && <div className="box error" role="alert">{error}</div>}
      {done && <div className="box ok" role="status">{done}</div>}

      {!editing && (
        <>
          <div className="card totals">
            <div className="label">Текущий остаток</div>
            <div className="big">{row ? fmt(row.balanceMinor, row.currencyKey) : snap.loading ? '…' : fmt(0, account.currencyKey)}</div>
            {row && row.currencyKey !== base && base && (
              <div className="row-sub">{row.balance.hasRate ? `≈ ${fmt(row.balance.minor!, base)}` : 'нет курса'}</div>
            )}
          </div>
          <div className="form">
            <button className="btn primary" disabled={busy} onClick={() => go('balance', { accountId: account.id })}>Ввести остаток</button>
            <button className="btn" disabled={busy} onClick={toggleArchive}>{account.archivedAt ? 'Вернуть из архива' : 'В архив'}</button>
          </div>
        </>
      )}

      {editing && (
        <div className="form">
          <label>Название
            <input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} />
          </label>
          <label>Раздел
            <select value={projectId} onChange={(e) => setProjectId(e.target.value)}>
              {ref.projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </label>
          <div>
            <div className="label-small">Цвет и иконка</div>
            <AppearancePicker color={color} icon={icon} onColor={setColor} onIcon={setIcon} />
          </div>
          <button className="btn primary" disabled={busy || !name.trim()} onClick={() => void save()}>{busy ? 'Сохраняем…' : 'Сохранить'}</button>
          <button className="btn" disabled={busy} onClick={() => setEditing(false)}>Отмена</button>
        </div>
      )}
    </Screen>
  )
}
