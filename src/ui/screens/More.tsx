import { useApp } from '../app'
import { Screen } from '../parts'

export function MoreScreen() {
  const { go, email, signOut, ctx } = useApp()
  return (
    <Screen title="Ещё">
      <ul className="plain menu">
        <li><button className="menu-item" onClick={() => go('periods')}>Закрытие периодов</button></li>
        <li><button className="menu-item" onClick={() => go('dump')}>Выгрузка и загрузка JSON</button></li>
      </ul>
      <div className="card">
        <p>{email}</p>
        <p className="muted">{ctx.actor.isOwner ? 'Роль: владелец' : 'Роль: без прав владельца'}</p>
        <button className="btn" onClick={() => void signOut()}>Выйти</button>
      </div>
    </Screen>
  )
}
