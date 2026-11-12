// Общие небольшие компоненты экранов.
import type { ReactNode } from 'react'
import type { Account, AccountType } from '../data/types'
import { COLORS, ICONS, resolveAppearance, type CheckpointDiff, type ColorKey, type GroupBy, type IconKey, type SnapshotRow, type SnapshotTotals } from '../core'
import { useApp, type RefData } from './app'
import { dateRu, money } from './format'

export const TYPE_LABELS: Record<AccountType, string> = {
  bank: 'Банки', wallet: 'Кошельки', broker: 'Брокер', cash: 'Наличные', person: 'У людей', firm: 'Фирмы',
}
export const GROUP_LABELS: Record<GroupBy, string> = {
  country: 'Страна', type: 'Тип места', holder: 'Держатель', project: 'Проект', institution: 'Учреждение',
}

export function groupTitle(by: GroupBy, key: string, ref: RefData): string {
  if (by === 'country') return ref.countries.find((c) => c.key === key)?.name ?? key
  if (by === 'type') return TYPE_LABELS[key as AccountType] ?? key
  if (by === 'holder') return key || 'Без держателя'
  if (by === 'project') return ref.projects.find((p) => p.id === key)?.name ?? key
  return ref.institutions.find((i) => i.id === key)?.name ?? (key ? key : 'Без учреждения')
}

export function Loading({ what = 'Загрузка…' }: { what?: string }) {
  return <p className="muted pad">{what}</p>
}
export function ErrorBox({ text, onRetry }: { text: string; onRetry?: () => void }) {
  return (
    <div className="box error" role="alert">
      <p>{text}</p>
      {onRetry && <button className="btn small" onClick={onRetry}>Повторить</button>}
    </div>
  )
}
export function Notice({ kind = 'warn', children }: { kind?: 'warn' | 'ok' | 'info'; children: ReactNode }) {
  return <div className={`box ${kind}`}>{children}</div>
}
export function Screen({ title, children, back }: { title: string; children: ReactNode; back?: ReactNode }) {
  return (
    <section className="screen">
      <header className="screen-head">{back}<h1>{title}</h1></header>
      {children}
    </section>
  )
}
export function BackButton({ to, label = 'Назад' }: { to: Parameters<ReturnType<typeof useApp>['go']>[0]; label?: string }) {
  const { go } = useApp()
  return <button className="link back" onClick={() => go(to)}>‹ {label}</button>
}

export function useCurrencyFormat() {
  const { ref } = useApp()
  const code = (key: string) => ref.cur.get(key)?.code ?? key.toUpperCase()
  const dec = (key: string) => ref.cur.get(key)?.decimals ?? 2
  const fmt = (minor: number, key: string) => `${money(minor, dec(key))}\u00a0${code(key)}`
  return { code, dec, fmt }
}

export function TotalsCard({ totals, title = 'Итого' }: { totals: SnapshotTotals; title?: string }) {
  const { fmt } = useCurrencyFormat()
  const { code } = useCurrencyFormat()
  return (
    <div className="card totals">
      <div className="label">{title} в {code(totals.baseCurrency)}</div>
      <div className="big">{fmt(totals.baseMinor, totals.baseCurrency)}</div>
      {!totals.complete && (
        <p className="warn-text">Нет курса: {totals.missingRateCurrencies.map(code).join(', ')}. Итог неполный.</p>
      )}
      <ul className="plain">
        {totals.byCurrency.map((t) => (
          <li key={t.currencyKey}><span>{code(t.currencyKey)}</span><b>{fmt(t.balanceMinor, t.currencyKey)}</b></li>
        ))}
      </ul>
      <div className="unaccounted">
        <span>Неучтённое</span>
        <b className={totals.unaccountedBaseMinor === 0 ? '' : 'warn-text'}>
          {totals.unaccountedBaseMinor === 0 ? '0 · учёт полный' : fmt(totals.unaccountedBaseMinor, totals.baseCurrency)}
        </b>
      </div>
    </div>
  )
}

export function AccountRow({ row, baseCurrency, onClick }: { row: SnapshotRow; baseCurrency: string; onClick?: () => void }) {
  const { fmt } = useCurrencyFormat()
  const { ref } = useApp()
  const account = ref.accounts.find((a) => a.id === row.accountId)
  const foreign = row.currencyKey !== baseCurrency
  return (
    <li className={`row${onClick ? ' tap' : ''}`} onClick={onClick}>
      {account && <AccountChip account={account} />}
      <div className="row-main grow">
        <span className="row-title">{row.name}</span>
        {row.unaccountedMinor !== 0 && <span className="row-sub warn-text">неучтённое: {fmt(row.unaccountedMinor, row.currencyKey)}</span>}
      </div>
      <div className="row-amount">
        <b>{fmt(row.balanceMinor, row.currencyKey)}</b>
        {foreign && (
          <span className="row-sub">
            {row.balance.hasRate ? `≈ ${fmt(row.balance.minor!, baseCurrency)}` : 'нет курса'}
          </span>
        )}
      </div>
    </li>
  )
}

export function DiffList({ diffs, accountName }: { diffs: CheckpointDiff[]; accountName: (id: string) => string }) {
  const { fmt } = useCurrencyFormat()
  const { ref } = useApp()
  return (
    <ul className="plain diffs">
      {diffs.map((d) => {
        const cur = ref.accounts.find((a) => a.id === d.accountId)?.currencyKey ?? ''
        return (
          <li key={d.checkpointId}>
            <b>{accountName(d.accountId)}</b> на {dateRu(d.asOf.slice(0, 10))}
            <div className="row-sub">точка {fmt(d.checkpointMinor, cur)} · расчёт {fmt(d.calculatedMinor, cur)} · разница {fmt(d.diffMinor, cur)}</div>
          </li>
        )
      })}
    </ul>
  )
}

// ---------- оформление счетов ----------

export function AccountChip({ account, color, icon, size = 36 }: { account: Pick<Account, 'id' | 'type' | 'appearance'>; color?: ColorKey | null; icon?: IconKey | null; size?: number }) {
  const r = resolveAppearance(account.appearance, account.id, account.type)
  const c = color ?? r.color
  const i = icon ?? r.icon
  return (
    <span className="chip" style={{ background: COLORS[c], width: size, height: size, fontSize: size * 0.5 }} aria-hidden="true">
      {ICONS[i]}
    </span>
  )
}

export function AppearancePicker({ color, icon, onColor, onIcon }: {
  color: ColorKey; icon: IconKey; onColor: (c: ColorKey) => void; onIcon: (i: IconKey) => void
}) {
  return (
    <div className="picker">
      <div className="swatches" role="radiogroup" aria-label="Цвет">
        {(Object.keys(COLORS) as ColorKey[]).map((c) => (
          <button type="button" key={c} role="radio" aria-checked={c === color} aria-label={c}
            className={c === color ? 'swatch on' : 'swatch'} style={{ background: COLORS[c] }} onClick={() => onColor(c)} />
        ))}
      </div>
      <div className="icons" role="radiogroup" aria-label="Иконка">
        {(Object.keys(ICONS) as IconKey[]).map((i) => (
          <button type="button" key={i} role="radio" aria-checked={i === icon} aria-label={i}
            className={i === icon ? 'icon on' : 'icon'} onClick={() => onIcon(i)}>{ICONS[i]}</button>
        ))}
      </div>
    </div>
  )
}
