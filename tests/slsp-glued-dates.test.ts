import { expect, it } from 'vitest'
import { parseSlspStatement } from '../src/core/statements'
import { buildSlsp } from './statements/slspFixture'

it('PDF Словакии, где две даты слиты в одно слово («04.09.202604.09.2026»), разбирается', () => {
  const st = parseSlspStatement(buildSlsp({
    opening: '1 000,00', deposits: '500,00', withdrawals: '- 10,00', closing: '1 490,00',
    pages: [[
      { dates: '04.09.202604.09.2026', lines: ['Platba kartou', 'Č. k. 1111 22** **** 3333', 'Lidl dakuje 165-BRATISLAVA 02. 09. 2026 17:10:34', 'Transakcia prostredníctvom GooglePay'], amount: '- 10,00', balance: '990,00' },
      { dates: '06.09.202606.09.2026', lines: ['Prijatá SEPA platba', 'SK00 0000 0000 0000 0000 0002 BIC: TESTSKBX', 'Názov protiúčtu: Test Sender'], amount: '500,00', balance: '1 490,00' },
    ]],
  }))
  const rows = st.accounts[0]!.rows
  expect(rows).toHaveLength(2)
  expect(rows[0]).toMatchObject({ valueDate: '2026-09-04', bookingDate: '2026-09-04', amountMinor: -1000 })
  expect(rows[1]).toMatchObject({ valueDate: '2026-09-06', amountMinor: 50000 })
})
