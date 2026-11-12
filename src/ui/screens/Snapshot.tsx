import { useState } from 'react'
import { getCheckpointDiffs, getSnapshot, groupSnapshot, type GroupBy } from '../../core'
import { useApp } from '../app'
import { useLoad } from '../hooks'
import { todayLocal } from '../format'
import {
  AccountRow, DiffList, ErrorBox, GROUP_LABELS, Loading, Notice, Screen, TotalsCard, groupTitle,
} from '../parts'

export function SnapshotScreen() {
  const { ctx, ref, go } = useApp()
  const [date, setDate] = useState(todayLocal())
  const [base, setBase] = useState(ref.settings.baseCurrency ?? ref.currencies[0]?.key ?? '')
  const [project, setProject] = useState('')
  const [group, setGroup] = useState<GroupBy | ''>('')

  const q = useLoad(async () => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null
    const snap = await getSnapshot(ctx, { date, projectIds: project ? [project] : undefined, baseCurrency: base || undefined })
    const diffs = snap.rows.length
      ? (await getCheckpointDiffs(ctx, { accountIds: snap.rows.map((r) => r.accountId), throughDate: date })).filter((d) => d.diffMinor !== 0)
      : []
    return { snap, diffs }
  }, [date, base, project])

  const name = (id: string) => ref.accounts.find((a) => a.id === id)?.name ?? id
  const rawGroups = q.data && group ? groupSnapshot(q.data.snap, group) : null
  const groups = rawGroups && group === 'project'
    ? [...rawGroups].sort((a, b) => (ref.projects.findIndex((p) => p.id === a.groupKey)) - (ref.projects.findIndex((p) => p.id === b.groupKey)))
    : rawGroups

  return (
    <Screen title="Срез на дату">
      <div className="filters">
        <label>Дата<input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></label>
        <label>Итог в валюте
          <select value={base} onChange={(e) => setBase(e.target.value)}>
            {ref.currencies.map((c) => <option key={c.key} value={c.key}>{c.code}</option>)}
          </select>
        </label>
        <label>Проект
          <select value={project} onChange={(e) => setProject(e.target.value)}>
            <option value="">Все</option>
            {ref.projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </label>
        <label>Группировка
          <select value={group} onChange={(e) => setGroup(e.target.value as GroupBy | '')}>
            <option value="">Без группировки</option>
            {(Object.keys(GROUP_LABELS) as GroupBy[]).map((g) => <option key={g} value={g}>{GROUP_LABELS[g]}</option>)}
          </select>
        </label>
      </div>

      {q.loading && <Loading />}
      {q.error && <ErrorBox text={q.error} onRetry={q.reload} />}
      {q.data && (
        <>
          {q.data.diffs.length > 0 && (
            <Notice>
              <b>Расхождение с контрольными точками</b>
              <DiffList diffs={q.data.diffs} accountName={name} />
            </Notice>
          )}
          {q.data.snap.rows.length === 0 && <Notice kind="info">На эту дату остатков нет.</Notice>}
          {q.data.snap.rows.length > 0 && <TotalsCard totals={q.data.snap.totals} />}
          {groups
            ? groups.map((g) => (
                <div key={g.groupKey} className="group">
                  <h2>{groupTitle(group as GroupBy, g.groupKey, ref)}</h2>
                  <ul className="plain rows">
                    {g.rows.map((r) => <AccountRow key={r.accountId} row={r} baseCurrency={q.data!.snap.totals.baseCurrency}
                      onClick={() => go('balance', { accountId: r.accountId })} />)}
                  </ul>
                  <TotalsCard totals={g.totals} title="Итого по группе" />
                </div>
              ))
            : (
              <ul className="plain rows">
                {q.data.snap.rows.map((r) => <AccountRow key={r.accountId} row={r} baseCurrency={q.data!.snap.totals.baseCurrency}
                  onClick={() => go('balance', { accountId: r.accountId })} />)}
              </ul>
            )}
        </>
      )}
    </Screen>
  )
}
