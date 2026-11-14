import { useState } from 'react'
import { BASE_CURRENCY_CHOICES, saveHomeSettings, setBaseCurrency, type HomeBlock, type HomeSettings } from '../../core'
import { useApp } from '../app'
import { errorText } from '../format'
import { BackButton, ErrorBox, Notice, Screen } from '../parts'
import { useDragSort } from '../dragSort'

const BLOCK_LABEL: Record<HomeBlock, string> = {
  rates: 'Курсы', accounts: 'Счета', sections: 'Итоги по разделам', total: 'Общий итог',
}

export function SettingsScreen() {
  const { ctx, ref, bump, reloadRef, refreshFx, fx } = useApp()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const current = ref.settings.baseCurrency
  const choices = BASE_CURRENCY_CHOICES.filter((k) => ref.cur.has(k))
  const h = ref.home
  const owner = ctx.actor.isOwner
  const drag = useDragSort(h.order, owner, (next) => saveHome({ ...h, order: next as HomeBlock[] }))

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

  async function saveHome(next: HomeSettings) {
    setError(null)
    try { await saveHomeSettings(ctx, next); await reloadRef(); bump() } catch (e) { setError(errorText(e)) }
  }
  const toggleAccount = (id: string) => saveHome({
    ...h, hiddenAccounts: h.hiddenAccounts.includes(id) ? h.hiddenAccounts.filter((x) => x !== id) : [...h.hiddenAccounts, id],
  })
  const active = ref.accounts.filter((a) => !a.archivedAt)

  return (
    <Screen title="Настройки" back={<BackButton to="more" />}>
      {error && <ErrorBox text={error} />}
      <div className="card">
        <div className="label">Базовая валюта итогов</div>
        <div className="seg" role="radiogroup" aria-label="Базовая валюта">
          {choices.map((k) => (
            <button key={k} role="radio" aria-checked={k === current} disabled={busy || !owner}
              className={k === current ? 'btn primary' : 'btn'} onClick={() => void pick(k)}>{ref.cur.get(k)!.code}</button>
          ))}
        </div>
        {!owner && <p className="muted">Менять может только владелец.</p>}
        {busy && <p className="muted">Обновляю курсы…</p>}
      </div>
      {fx && <Notice kind={fx.kind}>{fx.text}</Notice>}

      <div className="card form">
        <div className="label">Главная: что показывать</div>
        <label className="check"><input type="checkbox" checked={h.showSections} disabled={!owner} onChange={() => void saveHome({ ...h, showSections: !h.showSections })} />Итоги по разделам</label>
        <label className="check"><input type="checkbox" checked={h.showTotal} disabled={!owner} onChange={() => void saveHome({ ...h, showTotal: !h.showTotal })} />Общий итог</label>
        <label className="check"><input type="checkbox" checked={h.showDividers} disabled={!owner} onChange={() => void saveHome({ ...h, showDividers: !h.showDividers })} />Разделители между счетами</label>
      </div>

      <div className="card form">
        <div className="label">Главная: счета</div>
        <p className="muted">Не отмеченные счета не показываются на Главной и не входят в её итоги.</p>
        {ref.projects.map((p) => {
          const accs = active.filter((a) => a.projectId === p.id)
          if (accs.length === 0) return null
          return (
            <div key={p.id}>
              <div className="muted">{p.name}</div>
              {accs.map((a) => (
                <label key={a.id} className="check">
                  <input type="checkbox" checked={!h.hiddenAccounts.includes(a.id)} disabled={!owner} onChange={() => void toggleAccount(a.id)} />{a.name}
                </label>
              ))}
            </div>
          )
        })}
      </div>

      <div className="card">
        <div className="label">Главная: порядок блоков</div>
        <p className="muted">Перетащите за ручку ⠿.</p>
        <ul className="plain rows">
          {drag.order.map((b, i) => (
            <li key={b} ref={drag.setEl(b)} className={`row${drag.dragging === b ? ' dragging' : ''}`} style={drag.itemStyle(b, i)}>
              <div className="grow">{BLOCK_LABEL[b as HomeBlock]}</div>
              {owner && <span className="drag-handle" aria-label="Перетащить" role="button" {...drag.handleProps(b)}>⠿</span>}
            </li>
          ))}
        </ul>
      </div>
    </Screen>
  )
}
