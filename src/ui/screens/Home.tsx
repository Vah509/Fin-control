import { Fragment, useState } from 'react'
import { getCheckpointDiffs, getDisplayRates, getEnteredSnapshot, getSnapshot, groupTotalsByDividers, isDivider, orderProjects, projectItems, sectionTotals, visibleItems, type HomeBlock } from '../../core'
import { useApp } from '../app'
import { useLoad } from '../hooks'
import { dateRu, todayLocal } from '../format'
import { AccountRow, ErrorBox, NoDataRow, Loading, Notice, RatesCard, Screen, TotalsCard, useCurrencyFormat } from '../parts'

export function Home() {
  const { ctx, ref, go, fx, refreshFx } = useApp()
  const { fmt } = useCurrencyFormat()
  const today = todayLocal()
  const [mode, setMode] = useState<'moves' | 'balances'>('moves')
  const byBalances = mode === 'balances'
  const h = ref.home
  // Скрытые с Главной счета не входят и в её итоги; архивные с остатком в итогах остаются (как в «Аналитике»).
  const included = ref.accounts.filter((a) => !h.hiddenAccounts.includes(a.id))
  const key = included.map((a) => a.id).join(',')
  const q = useLoad(async () => {
    const ids = included.map((a) => a.id)
    if (mode === 'balances') {
      const e = await getEnteredSnapshot(ctx, { rateDate: today, accountIds: ids })
      const snap = { date: today, rows: e.rows, totals: e.totals }
      return { snap, diffs: [], rates: await getDisplayRates(ctx, today), dates: e.dateByAccount, missing: new Set(e.missing) }
    }
    const snap = await getSnapshot(ctx, { date: today, accountIds: ids })
    const diffs = snap.rows.length
      ? (await getCheckpointDiffs(ctx, { accountIds: snap.rows.map((r) => r.accountId), throughDate: today })).filter((d) => d.diffMinor !== 0)
      : []
    return { snap, diffs, rates: await getDisplayRates(ctx, today), dates: {} as Record<string, string>, missing: new Set<string>() }
  }, [today, key, mode])

  const shown = included.filter((a) => !a.archivedAt)
  const rowOf = (id: string) => q.data?.snap.rows.find((r) => r.accountId === id)

  function block(b: HomeBlock) {
    const d = q.data!
    if (b === 'rates') {
      if (!h.showRates) return null
      return (
        <div key={b}>
          <p className="muted rates-title">Средние курсы на {dateRu(today)}:</p>
          <RatesCard rates={d.rates} />
        </div>
      )
    }
    if (b === 'accounts') {
      if (!h.showAccounts) return null
      const totals = sectionTotals(d.snap)
      const base = d.snap.totals.baseCurrency
      return (
        <div key={b}>
          {orderProjects(h.projectOrder, ref.projects).map((p) => {
            const accs = shown.filter((a) => a.projectId === p.id)
            if (accs.length === 0) return null
            const items = projectItems(h.layout, p.id, accs)
            const list = h.showDividers ? visibleItems(items) : items.filter((id) => !isDivider(id))
            const t = totals.get(p.id)
            // Суммы групп: только если есть разделители и групп больше одной; сумма стоит в строке над группой.
            const groups = h.showGroupTotals && h.showDividers ? groupTotalsByDividers(list, d.snap.rows, base) : []
            const headOf = new Map(groups.map((g) => [g.ids[0]!, g]))
            const withHeads = groups.length > 1
            return (
              <div key={p.id} className="group">
                <div className="group-head">
                  <h2>{p.name}</h2>
                  {h.showSectionTotals && t && (
                    <span className={t.complete ? 'group-total' : 'group-total warn-text'}>{t.complete ? fmt(t.baseMinor, base) : 'нет курса'}</span>
                  )}
                </div>
                <ul className="plain rows">
                  {list.map((id, i) => {
                    if (isDivider(id)) return withHeads ? null : <li key={id} className="divider" aria-hidden="true" />
                    const a = accs.find((x) => x.id === id)!
                    const row = rowOf(a.id)
                    if (!row) return byBalances && d.missing.has(a.id) ? <NoDataRow key={id} account={a} onClick={() => go('account', { accountId: id })} /> : null
                    const g = withHeads ? headOf.get(id) : undefined
                    return (
                      <Fragment key={id}>
                        {g && <li className={i === 0 ? 'subhead first' : 'subhead'} aria-hidden="true"><span className={g.complete ? '' : 'warn-text'}>{g.complete ? fmt(g.baseMinor, base) : 'нет курса'}</span></li>}
                        <AccountRow row={row} baseCurrency={base} sub={byBalances && d.dates[id] ? `остаток на ${dateRu(d.dates[id]!)}` : undefined} onClick={() => go('account', { accountId: id })} />
                      </Fragment>
                    )
                  })}
                </ul>
              </div>
            )
          })}
        </div>
      )
    }
    return h.showTotal && d.snap.rows.length > 0 ? <TotalsCard key={b} totals={d.snap.totals} hideUnaccounted={byBalances} /> : null
  }

  return (
    <Screen title={`Сегодня, ${dateRu(today)}`}>
      <p className="muted" style={{ fontSize: '0.75rem', margin: '0 0 0.5rem' }}>
        Версия {__APP_VERSION__} · сборка {new Date(__BUILD_TIME__).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}
      </p>
      {fx && (
        <Notice kind={fx.kind}>{fx.text}{fx.kind === 'warn' && <>{' '}<button className="link" onClick={() => void refreshFx()}>Повторить</button></>}</Notice>
      )}
      <div className="seg" role="tablist" aria-label="Вид учёта" style={{ margin: '0 0 0.75rem' }}>
        <button role="tab" aria-selected={!byBalances} className={`btn${byBalances ? '' : ' primary'}`} onClick={() => setMode('moves')}>Движения</button>
        <button role="tab" aria-selected={byBalances} className={`btn${byBalances ? ' primary' : ''}`} onClick={() => setMode('balances')}>Остатки</button>
      </div>
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
