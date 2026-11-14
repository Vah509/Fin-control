import { useState } from 'react'
import { saveAccountsView, type AccountsView } from '../../core'
import { useApp } from '../app'
import { errorText } from '../format'
import { BackButton, ErrorBox, Screen } from '../parts'

export function AccountsSettingsScreen() {
  const { ctx, ref, bump, reloadRef } = useApp()
  const [error, setError] = useState<string | null>(null)
  const v = ref.accountsView
  const owner = ctx.actor.isOwner
  async function save(next: AccountsView) {
    setError(null)
    try { await saveAccountsView(ctx, next); await reloadRef(); bump() } catch (e) { setError(errorText(e)) }
  }
  const toggle = (id: string) => save({ ...v, hiddenAccounts: v.hiddenAccounts.includes(id) ? v.hiddenAccounts.filter((x) => x !== id) : [...v.hiddenAccounts, id] })
  const active = ref.accounts.filter((a) => !a.archivedAt)
  return (
    <Screen title="Настройки страницы «Счета»" back={<BackButton to="settings" />}>
      {error && <ErrorBox text={error} />}
      {!owner && <p className="muted pad">Менять может только владелец.</p>}
      <div className="card form">
        <div className="label">Какие счета показывать</div>
        <p className="muted">Снятый счёт не показывается на странице «Счета» и не входит в её суммы. Сам счёт и загрузка движений по нему не меняются.</p>
        {ref.projects.map((p) => {
          const accs = active.filter((a) => a.projectId === p.id)
          if (accs.length === 0) return null
          return (
            <div key={p.id}>
              <div className="muted">{p.name}</div>
              {accs.map((a) => (
                <label key={a.id} className="check">
                  <input type="checkbox" checked={!v.hiddenAccounts.includes(a.id)} disabled={!owner} onChange={() => void toggle(a.id)} />{a.name}
                </label>
              ))}
            </div>
          )
        })}
      </div>
      <div className="card form">
        <div className="label">Оформление</div>
        <label className="check"><input type="checkbox" checked={v.showGroupTotals} disabled={!owner} onChange={() => void save({ ...v, showGroupTotals: !v.showGroupTotals })} />Сумма группы над счетами (между разделителями)</label>
      </div>
    </Screen>
  )
}
