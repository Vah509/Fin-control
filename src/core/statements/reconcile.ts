// Сверка: цепочка остатков (остаток[i] = остаток[i-1] + сумма + комиссия) и итоги шапки. Расчёт в целых.
import type { Reconciliation, StatementAccount } from './types'

export function reconcileAccount(acc: StatementAccount): Reconciliation {
  const badRows: number[] = []
  let running = acc.openingMinor
  let dep = 0
  let wd = 0
  for (const r of acc.rows) {
    if (running + r.amountMinor + r.feeMinor !== r.balanceAfterMinor) badRows.push(r.n)
    running = r.balanceAfterMinor // пересинхронизация: одна ошибка не красит все следующие строки
    for (const v of [r.amountMinor, r.feeMinor]) { if (v > 0) dep += v; else wd -= v }
  }
  const ok = badRows.length === 0 && running === acc.closingMinor && dep === acc.depositsMinor && wd === acc.withdrawalsMinor
  return {
    accountKey: acc.key, ok, rowCount: acc.rows.length, badRows, firstBadRow: badRows[0] ?? null,
    openingMinor: acc.openingMinor, closingExpectedMinor: acc.closingMinor, closingComputedMinor: running,
    depositsExpectedMinor: acc.depositsMinor, depositsComputedMinor: dep,
    withdrawalsExpectedMinor: acc.withdrawalsMinor, withdrawalsComputedMinor: wd,
  }
}
