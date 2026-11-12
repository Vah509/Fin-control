import { useState } from 'react'
import { moveAccount, resolveAppearance, setAccountArchived, updateAccount, writeAppearance, type ColorKey, type IconKey } from '../../core'
import { useApp } from '../app'
import { errorText } from '../format'
import { AccountChip, AppearancePicker, BackButton, Notice, Screen, TYPE_LABELS, useCurrencyFormat } from '../parts'

export function AccountScreen({ accountId }: { accountId: string }) {
  const { ctx, ref, go, bump, reloadRef } = useApp()
  const { code } = useCurrencyFormat()
  const account = ref.accounts.find((a) => a.id === accountId)
  const start = account ? resolveAppearance(account.appearance, account.id, account.type) : null
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

  async function run(fn: () => Promise<void>, ok: string) {
    setBusy(true); setError(null); setDone(null)
    try { await fn(); await reloadRef(); bump(); setDone(ok) } catch (e) { setError(errorText(e)) } finally { setBusy(false) }
  }

  const save = () => run(async () => {
    const acc = account!
    await updateAccount(ctx, acc.id, { name: name.trim(), appearance: writeAppearance(acc.appearance, { color, icon }) })
    if (projectId !== acc.projectId) await moveAccount(ctx, acc.id, projectId)
  }, 'Сохранено.')

  const toggleArchive = () => run(async () => { await setAccountArchived(ctx, account.id, !account.archivedAt) },
    account.archivedAt ? 'Счёт возвращён из архива.' : 'Счёт в архиве: в срезах прошлых дат он остаётся.')

  return (
    <Screen title="Счёт" back={<BackButton to="accounts" label="Счета" />}>
      <div className="card account-head">
        <AccountChip account={account} color={color} icon={icon} size={52} />
        <div>
          <b>{name.trim() || account.name}</b>
          <div className="row-sub">{TYPE_LABELS[account.type]} · {code(account.currencyKey)} · {country}{institution ? ` · ${institution}` : ''}</div>
          {account.archivedAt && <div className="row-sub warn-text">В архиве</div>}
        </div>
      </div>

      <div className="form">
        <label>Название
          <input value={name} onChange={(e) => { setName(e.target.value); setDone(null) }} maxLength={80} />
        </label>
        <label>Раздел
          <select value={projectId} onChange={(e) => { setProjectId(e.target.value); setDone(null) }}>
            {ref.projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </label>
        <div>
          <div className="label-small">Цвет и иконка</div>
          <AppearancePicker color={color} icon={icon} onColor={(c) => { setColor(c); setDone(null) }} onIcon={(i) => { setIcon(i); setDone(null) }} />
        </div>
        {error && <div className="box error" role="alert">{error}</div>}
        {done && <div className="box ok" role="status">{done}</div>}
        <button className="btn primary" disabled={busy || !name.trim()} onClick={save}>{busy ? 'Сохраняем…' : 'Сохранить'}</button>
        <button className="btn" disabled={busy} onClick={() => go('balance', { accountId: account.id })}>Ввести остаток</button>
        <button className="btn" disabled={busy} onClick={toggleArchive}>{account.archivedAt ? 'Вернуть из архива' : 'В архив'}</button>
      </div>
    </Screen>
  )
}
