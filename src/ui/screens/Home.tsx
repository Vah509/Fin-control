import { getCheckpointDiffs, getSnapshot } from '../../core'
import { useApp } from '../app'
import { useLoad } from '../hooks'
import { dateRu, todayLocal } from '../format'
import { ErrorBox, Loading, Notice, Screen, TotalsCard } from '../parts'

export function Home() {
  const { ctx, go, fx, refreshFx } = useApp()
  const today = todayLocal()
  const q = useLoad(async () => {
    const snap = await getSnapshot(ctx, { date: today })
    const diffs = snap.rows.length
      ? (await getCheckpointDiffs(ctx, { accountIds: snap.rows.map((r) => r.accountId), throughDate: today })).filter((d) => d.diffMinor !== 0)
      : []
    return { snap, diffs }
  }, [today])

  return (
    <Screen title={`Сегодня, ${dateRu(today)}`}>
      <div className="actions">
        <button className="btn primary" onClick={() => go('balance')}>Ввести остаток</button>
        <button className="btn" onClick={() => go('snapshot')}>Срез на дату</button>
      </div>
      {fx && (
        <Notice kind={fx.kind}>{fx.text}{fx.kind === 'warn' && <>{' '}<button className="link" onClick={() => void refreshFx()}>Повторить</button></>}</Notice>
      )}
      {q.loading && <Loading />}
      {q.error && <ErrorBox text={q.error} onRetry={q.reload} />}
      {q.data && (
        <>
          {q.data.snap.rows.length === 0
            ? <Notice kind="info">Остатков пока нет. Введите стартовый остаток по счёту.</Notice>
            : <TotalsCard totals={q.data.snap.totals} />}
          {q.data.diffs.length > 0 && (
            <Notice>Расхождений с контрольными точками: {q.data.diffs.length}.{' '}
              <button className="link" onClick={() => go('snapshot')}>Посмотреть в срезе</button>
            </Notice>
          )}
        </>
      )}
    </Screen>
  )
}
