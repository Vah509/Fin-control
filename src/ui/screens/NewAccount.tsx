import { useState, type FormEvent } from 'react'
import {
  createAccount, createProject, defaultColor, makeKey, writeAppearance,
  type ColorKey, type IconKey,
} from '../../core'
import type { Account, AccountType, TrackingMode } from '../../data/types'
import { useApp } from '../app'
import { errorText } from '../format'
import { AppearancePicker, BackButton, Screen, TYPE_LABELS } from '../parts'

const TYPE_TEXT: Record<AccountType, string> = {
  bank: 'Банковский счёт или карта', wallet: 'Кошелёк (Revolut и т.п.)', broker: 'Брокерский счёт',
  cash: 'Наличные', person: 'Деньги у человека', firm: 'Фирма',
}
const TYPE_ICON: Record<AccountType, IconKey> = { bank: 'bank', wallet: 'wallet', broker: 'broker', cash: 'cash', person: 'person', firm: 'firm' }
const defaultMode = (t: AccountType): TrackingMode => (t === 'cash' || t === 'person' || t === 'broker' ? 'balance_only' : 'balance_and_movements')

export function NewAccountScreen() {
  const { ctx, ref, go, bump, reloadRef } = useApp()
  const [name, setName] = useState('')
  const [type, setType] = useState<AccountType>('bank')
  const [projectId, setProjectId] = useState(ref.projects[0]?.id ?? '')
  const [newProject, setNewProject] = useState('')
  const [currency, setCurrency] = useState(ref.settings.baseCurrency ?? ref.currencies[0]?.key ?? '')
  const [country, setCountry] = useState(ref.countries.find((c) => c.key !== 'none')?.key ?? ref.countries[0]?.key ?? '')
  const [mode, setMode] = useState<TrackingMode>('balance_and_movements')
  const [modeTouched, setModeTouched] = useState(false)
  const [institutionId, setInstitutionId] = useState('')
  const [holder, setHolder] = useState('')
  const [color, setColor] = useState<ColorKey>(defaultColor(name || 'new'))
  const [icon, setIcon] = useState<IconKey>('bank')
  const [iconTouched, setIconTouched] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [created, setCreated] = useState<Account | null>(null)

  function pickType(t: AccountType) {
    setType(t)
    if (!modeTouched) setMode(defaultMode(t))
    if (!iconTouched) setIcon(TYPE_ICON[t])
  }

  async function submit(e: FormEvent) {
    e.preventDefault()
    setBusy(true); setError(null)
    try {
      let pid = projectId
      if (projectId === '__new') {
        pid = (await createProject(ctx, { name: newProject })).id
      }
      const key = makeKey(name, ref.accounts.map((a) => a.key), 'schet')
      const acc = await createAccount(ctx, {
        key, name: name.trim(), type, projectId: pid, currencyKey: currency, countryKey: country, trackingMode: mode,
        institutionId: institutionId || null, holder: holder.trim() || null,
        appearance: writeAppearance({}, { color, icon }),
      })
      await reloadRef(); bump()
      setCreated(acc)
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  if (created) {
    return (
      <Screen title="Счёт создан" back={<BackButton to="accounts" label="Счета" />}>
        <div className="box ok" role="status">«{created.name}» добавлен. Теперь можно ввести стартовый остаток.</div>
        <div className="actions">
          <button className="btn primary" onClick={() => go('balance', { accountId: created.id })}>Ввести остаток</button>
          <button className="btn" onClick={() => go('accounts')}>К счетам</button>
        </div>
      </Screen>
    )
  }

  const valid = name.trim() !== '' && currency !== '' && country !== '' && (projectId !== '__new' ? projectId !== '' : newProject.trim() !== '')
  return (
    <Screen title="Новый счёт" back={<BackButton to="accounts" label="Счета" />}>
      <form className="form" onSubmit={submit}>
        <label>Название
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} placeholder="Например, monobank чёрная" required />
        </label>
        <label>Раздел
          <select value={projectId} onChange={(e) => setProjectId(e.target.value)}>
            {ref.projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            <option value="__new">+ Новый раздел…</option>
          </select>
        </label>
        {projectId === '__new' && (
          <label>Название нового раздела
            <input value={newProject} onChange={(e) => setNewProject(e.target.value)} maxLength={60} />
          </label>
        )}
        <label>Тип
          <select value={type} onChange={(e) => pickType(e.target.value as AccountType)}>
            {(Object.keys(TYPE_LABELS) as AccountType[]).map((t) => <option key={t} value={t}>{TYPE_TEXT[t]}</option>)}
          </select>
        </label>
        <label>Валюта
          <select value={currency} onChange={(e) => setCurrency(e.target.value)}>
            {ref.currencies.map((c) => <option key={c.key} value={c.key}>{c.code}</option>)}
          </select>
        </label>
        <label>Страна
          <select value={country} onChange={(e) => setCountry(e.target.value)}>
            {ref.countries.map((c) => <option key={c.key} value={c.key}>{c.name}</option>)}
          </select>
        </label>
        <label>Учёт
          <select value={mode} onChange={(e) => { setMode(e.target.value as TrackingMode); setModeTouched(true) }}>
            <option value="balance_and_movements">Остатки и движения (банки с выписками)</option>
            <option value="balance_only">Только остатки (наличные, люди, брокер)</option>
          </select>
        </label>
        <label>Учреждение (необязательно)
          <select value={institutionId} onChange={(e) => setInstitutionId(e.target.value)}>
            <option value="">Не выбрано</option>
            {ref.institutions.map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}
          </select>
        </label>
        <label>Держатель (необязательно)
          <input value={holder} onChange={(e) => setHolder(e.target.value)} maxLength={60} />
        </label>
        <div>
          <div className="label-small">Цвет и иконка</div>
          <AppearancePicker color={color} icon={icon} onColor={setColor} onIcon={(i) => { setIcon(i); setIconTouched(true) }} />
        </div>
        {error && <div className="box error" role="alert">{error}</div>}
        <button className="btn primary" disabled={busy || !valid}>{busy ? 'Создаём…' : 'Создать счёт'}</button>
      </form>
    </Screen>
  )
}
