import { currentLock } from '../../core'
import { useApp } from '../app'
import { useLoad } from '../hooks'
import { dateRu } from '../format'
import { Screen } from '../parts'

export function MoreScreen() {
  const { go, email, signOut, ctx } = useApp()
  const locks = useLoad(() => ctx.storage.listPeriodLocks(), [])
  const cur = locks.data ? currentLock(locks.data) : null
  const lockText = locks.data ? (cur ? `закрыт по ${dateRu(cur.lockedThrough)}` : 'не закрыт') : null
  return (
    <Screen title="Прочее">
      <ul className="plain menu">
        <li><button className="menu-item" onClick={() => go('settings')}>Настройки</button></li>
        <li><button className="menu-item" onClick={() => go('periods')}>Закрытие периодов{lockText && <span className="row-sub">{lockText}</span>}</button></li>
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
