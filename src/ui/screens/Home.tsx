import { getCheckpointDiffs, getDisplayRates, getSnapshot, isDivider, projectItems, sectionTotals, visibleItems, type HomeBlock } from '../../core'
import { useApp } from '../app'
import { useLoad } from '../hooks'
import { dateRu, todayLocal } from '../format'
import { AccountRow, ErrorBox, Loading, Notice, RatesCard, Screen, TotalsCard, useCurrencyFormat } from '../parts'

export function Home() {
  const { ctx, ref, go, fx, refreshFx } = useApp()
  const { fmt } = useCurrencyFormat()
  const today = todayLocal()
  const h = ref.home
  // Скрытые с Главной счета не входят и в её итоги; архивные с остатком в итогах остаются (как в «Аналитике»).
  const included = ref.accounts.filter((a) => !h.hiddenAccounts.includes(a.id))
  const key = included.map((a) => a.id).join(',')
  const q = useLoad(async () => {
    const snap = await getSnapshot(ctx, { date: today, accountIds: included.map((a) => a.id) })
    const diffs = snap.rows.length
      ? (await getCheckpointDiffs(ctx, { accountIds: snap.rows.map((r) => r.accountId), throughDate: today })).filter((d) => d.diffMinor !== 0)
      : []
    return { snap, diffs, rates: await getDisplayRates(ctx, today) }
  }, [today, key])

  const shown = included.filter((a) => !a.archivedAt)
  const rowOf = (id: string) => q.data?.snap.rows.find((r) => r.accountId === id)

  function block(b: HomeBlock) {
    const d = q.data!
    if (b === 'rates') {
      return (
        <div key={b}>
          <p className="muted rates-title">Средние курсы на {dateRu(today)}:</p>
          <RatesCard rates={d.rates} />
        </div>
      )
    }
    if (b === 'accounts') {
      return (
        <div key={b}>
          {ref.projects.map((p) => {
            const accs = shown.filter((a) => a.projectId === p.id)
            if (accs.length === 0) return null
            const items = projectItems(ref.layout, p.id, accs)
            const list = h.showDividers ? visibleItems(items) : items.filter((id) => !isDivider(id))
            return (
              <div key={p.id} className="group">
                <div className="group-head"><h2>{p.name}</h2></div>
                <ul className="plain rows">
                  {list.map((id) => {
                    if (isDivider(id)) return <li key={id} className="divider" aria-hidden="true" />
                    const a = accs.find((x) => x.id === id)!
                    const row = rowOf(a.id)
                    return row ? <AccountRow key={id} row={row} baseCurrency={d.snap.totals.baseCurrency} onClick={() => go('account', { accountId: id })} /> : null
                  })}
                </ul>
              </div>
            )
          })}
        </div>
      )
    }
    if (b === 'sections') {
      if (!h.showSections) return null
      const t = sectionTotals(d.snap)
      const list = ref.projects.filter((p) => t.has(p.id))
      if (list.length === 0) return null
      const base = d.snap.totals.baseCurrency
      return (
        <div key={b} className="card totals">
          <div className="label">Итоги по разделам</div>
          <ul className="plain">
            {list.map((p) => {
              const x = t.get(p.id)!
              return <li key={p.id}><span>{p.name}</span>{x.complete ? <b>{fmt(x.baseMinor, base)}</b> : <b className="warn-text">нет курса</b>}</li>
            })}
          </ul>
        </div>
      )
    }
    return h.showTotal && d.snap.rows.length > 0 ? <TotalsCard key={b} totals={d.snap.totals} /> : null
  }

  return (
    <Screen title={`Сегодня, ${dateRu(today)}`}>
      {fx && (
        <Notice kind={fx.kind}>{fx.text}{fx.kind === 'warn' && <>{' '}<button className="link" onClick={() => void refreshFx()}>Повторить</button></>}</Notice>
      )}
      {q.loading && <Loading />}
      {q.error && <ErrorBox text={q.error} onRetry={q.reload} />}
      {q.data && (
        <>
          {shown.length === 0 && <Notice kind="info">На Главной нет счетов. Выберите их в «Прочее → Настройки» или заведите счёт.</Notice>}
          {q.data.diffs.length > 0 && (
            <Notice>Расхождений с контрольными точками: {q.data.diffs.length}.{' '}
              <button className="link" onClick={() => go('snapshot')}>Посмотреть в срезе</button>
            </Notice>
          )}
          {h.order.map(block)}
        </>
      )}
    </Screen>
  )
}
