// Выдуманные выписки SPACE для ручной проверки экрана решения проблем (PDF строятся из этих данных, см. docs/TEST-DATA.md).
import { buildSlsp, type FxStatement } from './slspFixture'

const card = (d: string, shop: string, amount: string, balance: string) => ({
  dates: `${d} ${d}`, lines: ['Platba kartou', 'Č. k. 1111 22** **** 3333', `${shop}-BRATISLAVA ${d.slice(0, 2)}. ${d.slice(3, 5)}. ${d.slice(6)} 10:00:00`, 'Transakcia prostredníctvom GooglePay'], amount, balance,
})
const sepa = (d: string, iban: string, name: string, amount: string, balance: string) => ({
  dates: `${d} ${d}`, lines: ['Prijatá SEPA platba', `${iban} BIC: TESTSKBX`, `Názov protiúčtu: ${name}`], amount, balance,
})
const A = '- 10,00'
export interface Scenario { file: string; what: string; statement: FxStatement }
const num = (last: string) => `SK00 0000 0000 0000 0000 ${last}`

export const SCENARIOS: Scenario[] = [
  { file: 'test-1-tolko-v-baze-9001', what: 'нет +500,00 от 06.09: в базе она лишняя (проблема «Только в базе»)',
    statement: { number: num('9001'), opening: '1 000,00', deposits: '0,00', withdrawals: '- 30,00', closing: '970,00', pages: [[card('03.09.2026', 'Shop A', A, '990,00'), card('05.09.2026', 'Shop B', '- 20,00', '970,00')]] } },
  { file: 'test-2-summa-9001', what: 'Shop A −10,50 вместо −10,00 в базе (проблема «Сумма расходится»)',
    statement: { number: num('9001'), opening: '1 000,00', deposits: '500,00', withdrawals: '- 30,50', closing: '1 469,50', pages: [[card('03.09.2026', 'Shop A', '- 10,50', '989,50'), card('05.09.2026', 'Shop B', '- 20,00', '969,50'), sepa('06.09.2026', num('0002'), 'Test Sender', '500,00', '1 469,50')]] } },
  { file: 'test-3-schet-7777', what: 'счёт …7777, которого нет в базе (проблема «Счёта нет»)',
    statement: { number: num('7777'), opening: '1 000,00', deposits: '100,00', withdrawals: '- 10,00', closing: '1 090,00', pages: [[card('03.09.2026', 'Shop A', A, '990,00'), sepa('06.09.2026', num('0003'), 'Test Sender', '100,00', '1 090,00')]] } },
  { file: 'test-4-perevod-9001', what: 'приход от «Test Own USD» (контрагент «свой счёт» в USD) на EUR-счёт: перевод без пары',
    statement: { number: num('9001'), opening: '1 000,00', deposits: '600,00', withdrawals: '- 30,00', closing: '1 570,00', pages: [[card('03.09.2026', 'Shop A', A, '990,00'), card('05.09.2026', 'Shop B', '- 20,00', '970,00'), sepa('06.09.2026', num('0002'), 'Test Sender', '500,00', '1 470,00'), sepa('07.09.2026', num('0004'), 'Test Own USD', '100,00', '1 570,00')]] } },
  { file: 'test-5-data-9001', what: 'Shop B на 08.09 вместо 05.09 в базе (проблема «Дата расходится», решения нет)',
    statement: { number: num('9001'), opening: '1 000,00', deposits: '500,00', withdrawals: '- 30,00', closing: '1 470,00', pages: [[card('03.09.2026', 'Shop A', A, '990,00'), sepa('06.09.2026', num('0002'), 'Test Sender', '500,00', '1 490,00'), card('08.09.2026', 'Shop B', '- 20,00', '1 470,00')]] } },
]
export const scenarioPages = (s: Scenario) => buildSlsp(s.statement)
