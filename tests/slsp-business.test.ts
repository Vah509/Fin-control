import { expect, it } from 'vitest'
import { parseSlspStatement } from '../src/core/statements'
import { reconcileAccount } from '../src/core/statements/reconcile'
import { buildSlsp } from './statements/slspFixture'

// Бизнес-счёт («Podnikateľský účet»): в таблице нет колонки «Zostatok po transakcii».
const noBalance = () => buildSlsp({
  opening: '1 000,00', deposits: '2 000,00', withdrawals: '- 100,00', closing: '2 900,00',
  pages: [[
    { dates: '02.07.202602.07.2026', lines: ['Prijatá SEPA platba', 'SK00 0000 0000 0000 0000 0002 BIC: TESTSKBX', 'Názov protiúčtu: Test Client, s.r.o.', 'VS: 052026 KS: 0308'], amount: '2 000,00', balance: 'X' },
    { dates: '04.07.2026 04.07.2026', lines: ['Okamžitá platba (elektronicky)', 'SK00 0000 0000 0000 0000 0003 BIC: TESTSKBX', 'Názov protiúčtu: Test Fund', 'VS: 7201 SS: 62026 KS: 3558'], amount: '- 100,00', balance: 'X' },
  ]],
}).map((p) => ({ items: p.items.filter((i) => i.str !== 'Zostatok' && i.str !== 'po transakcii' && i.str !== 'X') }))

it('выписка без колонки остатка: остаток считается от начального, сверка по итогам, имя без VS/KS', () => {
  const a = parseSlspStatement(noBalance()).accounts[0]!
  expect(a.rows.map((r) => r.balanceAfterMinor)).toEqual([300000, 290000])
  expect(a.rows.map((r) => r.counterparty.name)).toEqual(['Test Client, s.r.o.', 'Test Fund'])
  expect(reconcileAccount(a).ok).toBe(true)
})
it('выписка без колонки остатка: неверный итог шапки не сходится', () => {
  const pages = noBalance()
  const bad = parseSlspStatement(pages.map((p) => ({ items: p.items.map((i) => (i.str === '2 900,00' ? { ...i, str: '2 901,00' } : i)) }))).accounts[0]!
  expect(reconcileAccount(bad).ok).toBe(false)
})
