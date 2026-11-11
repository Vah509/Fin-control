import { useApp } from '../app'
import { useLoad } from '../hooks'
import { dateTimeRu } from '../format'
import { ErrorBox, Loading, Notice, Screen, useCurrencyFormat } from '../parts'

const TYPE_TEXT = { income: 'Приход', expense: 'Расход', transfer: 'Перевод', fee: 'Комиссия', adjustment: 'Корректировка' } as const

/** Пока только просмотр последних записей за 30 дней. Ввод движений и импорт будут в шаге 5. */
export function MovesScreen() {
  const { ctx, ref } = useApp()
  const { fmt } = useCurrencyFormat()
  const q = useLoad(async () => {
    const from = new Date(Date.now() - 30 * 86400_000).toISOString()
    const txs = await ctx.storage.listTransactions({ bookedFrom: from })
    return txs.sort((a, b) => b.bookedAt.localeCompare(a.bookedAt)).slice(0, 100)
  }, [])
  return (
    <Screen title="Движения">
      <Notice kind="info">Ввод движений и импорт выписок появятся на следующем этапе. Здесь последние записи за 30 дней.</Notice>
      {q.loading && <Loading />}
      {q.error && <ErrorBox text={q.error} onRetry={q.reload} />}
      {q.data && q.data.length === 0 && <p className="muted pad">За 30 дней записей нет.</p>}
      {q.data && (
        <ul className="plain rows">
          {q.data.map((t) => (
            <li key={t.id} className="row">
              <div className="row-main">
                <span className="row-title">{ref.accounts.find((a) => a.id === t.accountId)?.name ?? t.accountId}</span>
                <span className="row-sub">{TYPE_TEXT[t.type]}{t.isOpening ? ' · стартовый остаток' : ''} · {dateTimeRu(t.bookedAt)}</span>
                {t.comment && <span className="row-sub">{t.comment}</span>}
              </div>
              <b>{fmt(t.amountMinor, t.currencyKey)}</b>
            </li>
          ))}
        </ul>
      )}
    </Screen>
  )
}
