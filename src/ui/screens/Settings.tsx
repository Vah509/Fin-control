import { useApp } from '../app'
import { BackButton, Screen } from '../parts'

export function SettingsScreen() {
  const { go, ref } = useApp()
  const key = ref.settings.baseCurrency
  const code = key ? (ref.cur.get(key)?.code ?? key.toUpperCase()) : 'не задана'
  return (
    <Screen title="Настройки" back={<BackButton to="more" />}>
      <ul className="plain menu">
        <li><button className="menu-item" onClick={() => go('baseCurrency')}>Базовая валюта<span className="row-sub">сейчас установлено: {code}</span></button></li>
        <li><button className="menu-item" onClick={() => go('homeSettings')}>Настройки главного экрана</button></li>
      </ul>
    </Screen>
  )
}
