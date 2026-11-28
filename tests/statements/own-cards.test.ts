import { describe, expect, it } from 'vitest'
import ExcelJS from 'exceljs'
import { collectCounterpartyGroups, parsePrivatStatement, recognizeGroups } from '../../src/core/statements'
import { createAccount } from '../../src/core'
import { account, setup } from '../helpers'

const HEAD = ['Дата', 'Категорія', 'Картка', 'Опис операції', 'Сума в валюті картки', 'Валюта картки', 'Сума в валюті транзакції', 'Валюта транзакції', 'Залишок на кінець періоду', 'Валюта залишку']
const C1 = '1111 **** **** 0001', C2 = '2222 **** **** 0002', C3 = '5457 **** **** 0206', C4 = '4149 **** **** 9335'
const r = (d: string, card: string, desc: string, a: number, bal: number) => [d, 'Перекази', card, desc, a, 'UAH', Math.abs(a), 'UAH', bal, 'UAH']
// выдуманные данные: маска «*0002», сокращённая «54**06», без номера (пара по времени, комиссия), пара без совпадения
const ROWS = [
  r('20.11.2026 10:00:00', C1, 'На свою картку *0002', -100, 900),
  r('20.11.2026 10:00:00', C2, 'Зі своєї картки *0001', 100, 600),
  r('21.11.2026 11:00:00', C1, 'На свою картку 54**06', -50, 850),
  r('21.11.2026 11:00:02', C3, 'Зі своєї картки', 50, 50),
  r('22.11.2026 12:00:00', C4, 'На картку', -30, 70),
  r('23.11.2026 12:00:00', C2, 'Зі своєї картки', 70, 670),
]
async function book(rows: unknown[][]): Promise<Uint8Array> {
  const wb = new ExcelJS.Workbook(); const ws = wb.addWorksheet('Виписки')
  ws.addRow(['Історія операцій за період 20.11.2026 - 28.11.2026']); ws.addRow(HEAD); rows.forEach((x) => ws.addRow(x))
  return new Uint8Array((await wb.xlsx.writeBuffer()) as ArrayBuffer)
}

describe('переводы между своими картами (Приват)', () => {
  it('маска, сокращённая маска и пара по времени опознаются; одинокие строки остаются как были', async () => {
    const st = await parsePrivatStatement(await book([...ROWS].reverse()))
    const own = (key: string) => st.accounts.find((a) => a.key === key)!.rows.map((x) => x.counterparty.ownLast4 ?? null)
    expect(own('0001')).toEqual(['0002', '0206'])
    expect(own('0002')).toEqual(['0001', null])
    expect(own('0206')).toEqual(['0001'])
    expect(own('9335')).toEqual([null])
    const names = collectCounterpartyGroups(st).map((g) => g.text)
    expect(names).toContain('Свій рахунок •••• 0002')
    expect(names).toContain('На картку')
  })

  it('контрагент «свой счёт» создаётся для каждого счёта (старого и нового) и находит карту по последним 4 цифрам', async () => {
    const { ctx, storage } = await setup({ withCrypto: true })
    await storage.applyBatch({ put: {
      accounts: [account({ id: 'a1', key: 'privat-0001', name: 'Приват 0001', currencyKey: 'uah', countryKey: 'ua' }), account({ id: 'a2', key: 'privat-0002', name: 'Приват 0002', currencyKey: 'uah', countryKey: 'ua' })],
      accountIdentifiers: [{ id: 'i2', accountId: 'a2', kind: 'account_number', valueHash: 'h2', valueEnc: 'e', last4: '0002', validFrom: '2020-01-01', validTo: null }],
    } } as never)
    const st = await parsePrivatStatement(await book([...ROWS].reverse()))
    const groups = collectCounterpartyGroups(st)
    const found = await recognizeGroups(ctx, groups)
    const cps = await storage.list('counterparties')
    const accs = await storage.list('accounts')
    expect(cps.filter((c) => c.kind === 'own_account').map((c) => c.accountId).sort()).toEqual(accs.map((a) => a.id).sort())   // по одному на каждый счёт, включая заведённые в setup
    const g = groups.findIndex((x) => x.ownLast4 === '0002')
    expect(found[g]).toMatchObject({ kind: 'own_account', accountId: 'a2' })
    expect(found[groups.findIndex((x) => x.ownLast4 === '0001')]).toBeNull()   // у счёта a1 нет признака «0001»
    // повторный вызов ничего не дублирует
    await recognizeGroups(ctx, groups)
    expect((await storage.list('counterparties')).filter((c) => c.kind === 'own_account')).toHaveLength(accs.length)
    // новый счёт получает контрагента сразу
    const n = await createAccount(ctx, { key: 'new-acc', name: 'Новый', type: 'bank', projectId: 'p-lichnoe', currencyKey: 'uah', countryKey: 'ua', trackingMode: 'balance_and_movements' })
    expect((await storage.list('counterparties')).find((c) => c.accountId === n.id)).toMatchObject({ kind: 'own_account', name: 'Новый' })
  })
})
