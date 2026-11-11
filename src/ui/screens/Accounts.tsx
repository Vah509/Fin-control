import { getSnapshot } from '../../core'
import { useApp } from '../app'
import { useLoad } from '../hooks'
import { todayLocal } from '../format'
import { AccountRow, ErrorBox, Loading, Screen } from '../parts'

export function AccountsScreen() {
  const { ctx, ref, go } = useApp()
  const today = todayLocal()
  const q = useLoad(() => getSnapshot(ctx, { date: today }), [today])
  const base = q.data?.totals.baseCurrency ?? ''
  return (
    <Screen title="Счета">
      {q.loading && <Loading />}
      {q.error && <ErrorBox text={q.error} onRetry={q.reload} />}
      {q.data && ref.projects.map((p) => {
        const rows = q.data!.rows.filter((r) => r.projectId === p.id)
        if (rows.length === 0) return null
        return (
          <div key={p.id} className="group">
            <h2>{p.name}</h2>
            <ul className="plain rows">
              {rows.map((r) => <AccountRow key={r.accountId} row={r} baseCurrency={base} onClick={() => go('balance', { accountId: r.accountId })} />)}
            </ul>
          </div>
        )
      })}
      <p className="muted pad">Нажмите на счёт, чтобы ввести остаток. Счета без записей на сегодня показаны с нулём.</p>
    </Screen>
  )
}
