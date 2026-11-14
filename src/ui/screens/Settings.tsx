import { useState } from 'react'
import { BASE_CURRENCY_CHOICES, setBaseCurrency } from '../../core'
import { useApp } from '../app'
import { errorText } from '../format'
import { BackButton, ErrorBox, Notice, Screen } from '../parts'

export function SettingsScreen() {
  const { ctx, ref, go, bump, reloadRef, refreshFx, fx } = useApp()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const current = ref.settings.baseCurrency
  const choices = BASE_CURRENCY_CHOICES.filter((k) => ref.cur.has(k))

  async function pick(key: string) {
    if (key === current || busy) return
    setBusy(true); setError(null)
    try {
      await setBaseCurrency(ctx, key)
      await reloadRef()
      await refreshFx()   // недостающие курсы для новой базовой валюты
      bump()
    } catch (e) { setError(errorText(e)) } finally { setBusy(false) }
  }

  return (
    <Screen title="Настройки" back={<BackButton to="more" />}>
      {error && <ErrorBox text={error} />}
      <div className="card">
        <div className="label">Базовая валюта итогов</div>
        <div className="seg" role="radiogroup" aria-label="Базовая валюта">
          {choices.map((k) => (
            <button key={k} role="radio" aria-checked={k === current} disabled={busy || !ctx.actor.isOwner}
              className={k === current ? 'btn primary' : 'btn'} onClick={() => void pick(k)}>{ref.cur.get(k)!.code}</button>
          ))}
        </div>
        {!ctx.actor.isOwner && <p className="muted">Менять может только владелец.</p>}
        {busy && <p className="muted">Обновляю курсы…</p>}
      </div>
      {fx && <Notice kind={fx.kind}>{fx.text}</Notice>}
      <ul className="plain menu">
        <li><button className="menu-item" onClick={() => go('homeSettings')}>Главный экран<span className="row-sub">блоки, счета, порядок и оформление</span></button></li>
      </ul>
    </Screen>
  )
}
