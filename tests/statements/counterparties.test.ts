import { describe, expect, it } from 'vitest'
import { CoreError } from '../../src/core'
import { applyCounterpartyFile, buildCounterpartyWorkbook, collectCounterpartyGroups, parseSlspStatement, readCounterpartyWorkbook, recognizeGroups, type CpFileRow } from '../../src/core/statements'
import { setup } from '../helpers'
import { buildSlsp } from './slspFixture'

const stmt = () => parseSlspStatement(buildSlsp({
  opening: '1 000,00', deposits: '500,00', withdrawals: '- 20,00', closing: '1 480,00',
  pages: [[
    { dates: '04.09.2026 04.09.2026', lines: ['Platba kartou', 'Č. k. 1111 22** **** 3333', 'Lidl dakuje 165-BRATISLAVA 02. 09. 2026 17:10:34', 'Transakcia prostredníctvom GooglePay'], amount: '- 10,00', balance: '990,00' },
    { dates: '05.09.2026 05.09.2026', lines: ['Platba kartou', 'Č. k. 1111 22** **** 3333', 'Lidl dakuje 185-BRATISLAVA 03. 09. 2026 10:10:10', 'Transakcia prostredníctvom GooglePay'], amount: '- 10,00', balance: '980,00' },
    { dates: '06.09.2026 06.09.2026', lines: ['Prijatá SEPA platba', 'SK00 0000 0000 0000 0000 0002 BIC: TESTSKBX', 'Názov protiúčtu: Test Sender'], amount: '500,00', balance: '1 480,00' },
    { dates: '07.09.2026 07.09.2026', lines: ['Platba kartou', 'Č. k. 1111 22** **** 3333', 'Lidl dakuje 165-BRATISLAVA 05. 09. 2026 09:00:00', 'Transakcia prostredníctvom GooglePay'], amount: '0,00', balance: '1 480,00' },
  ]],
}))
const row = (n: number, text: string, extra: Partial<CpFileRow> = {}): CpFileRow => ({ row: n, text, resolved: '', newName: '', iban: null, ...extra })

describe('файл контрагентов', () => {
  it('уникальные контрагенты: карта по названию, SEPA по IBAN', () => {
    const g = collectCounterpartyGroups(stmt())
    expect(g.map((x) => [x.text, x.iban, x.rows])).toEqual([
      ['Lidl dakuje 165-BRATISLAVA', null, 2], ['Lidl dakuje 185-BRATISLAVA', null, 1], ['Test Sender', 'SK0000000000000000000002', 1],
    ])
  })

  it('новые: пусто во 2-й колонке; одинаковые имена из колонки 3 сводятся к одному; опознание после загрузки', async () => {
    const { ctx, storage } = await setup({ withCrypto: true })
    const res = await applyCounterpartyFile(ctx, [
      row(2, 'Lidl dakuje 165-BRATISLAVA', { newName: 'Lidl' }), row(3, 'Lidl dakuje 185-BRATISLAVA', { newName: 'Lidl' }),
      row(4, 'Test Sender', { iban: 'SK0000000000000000000002' }),
    ])
    expect(res).toMatchObject({ created: 2, identifiersAdded: 4, reassigned: 0, rowsLinked: 3 })
    const cps = await storage.list('counterparties')
    expect(cps.map((c) => c.name).sort()).toEqual(['Lidl', 'Test Sender'])
    expect(cps.every((c) => c.kind === 'organization')).toBe(true)
    const found = await recognizeGroups(ctx, collectCounterpartyGroups(stmt()))
    expect(found.map((c) => c?.name)).toEqual(['Lidl', 'Lidl', 'Test Sender'])
    const ibanId = (await storage.list('counterpartyIdentifiers')).find((i) => i.kind === 'account_number')!
    expect(ibanId.value).toBeNull(); expect(ibanId.last4).toBe('0002'); expect(ibanId.valueEnc).toBeTruthy()
  })

  it('без колонки 3 имя = текст из колонки 1', async () => {
    const { ctx, storage } = await setup({ withCrypto: true })
    await applyCounterpartyFile(ctx, [row(2, 'Edge Cafe-BRATISLAVA')])
    expect((await storage.list('counterparties'))[0]!.name).toBe('Edge Cafe-BRATISLAVA')
  })

  it('указан существующий: добавляется признак; повторная загрузка ничего не меняет', async () => {
    const { ctx, storage } = await setup({ withCrypto: true })
    await applyCounterpartyFile(ctx, [row(2, 'Lidl dakuje 165-BRATISLAVA', { newName: 'Lidl' })])
    const r = await applyCounterpartyFile(ctx, [row(2, 'Lidl dakuje 185-BRATISLAVA', { resolved: ' lidl ' }), row(3, 'Lidl dakuje 165-BRATISLAVA', { resolved: 'Lidl' })])
    expect(r).toMatchObject({ created: 0, identifiersAdded: 1, reassigned: 0 })
    const again = await applyCounterpartyFile(ctx, [row(2, 'Lidl dakuje 185-BRATISLAVA', { resolved: 'Lidl' })])
    expect(again.identifiersAdded).toBe(0)
    expect(await storage.list('counterpartyIdentifiers')).toHaveLength(2)
  })

  it('опечатка во 2-й колонке: отказ с номером строки, ничего не записано', async () => {
    const { ctx, storage } = await setup({ withCrypto: true })
    await applyCounterpartyFile(ctx, [row(2, 'A shop', { newName: 'Lidl' })])
    const before = await storage.list('counterpartyIdentifiers')
    const err = await applyCounterpartyFile(ctx, [row(2, 'New one'), row(5, 'B shop', { resolved: 'Lidll' })]).catch((e) => e)
    expect(err).toBeInstanceOf(CoreError)
    expect(err.code).toBe('COUNTERPARTY_FILE_INVALID')
    expect(err.message).toContain('строка 5')
    expect(await storage.list('counterparties')).toHaveLength(1)
    expect(await storage.list('counterpartyIdentifiers')).toEqual(before)
  })

  it('новое имя совпало с существующим: отказ', async () => {
    const { ctx } = await setup({ withCrypto: true })
    await applyCounterpartyFile(ctx, [row(2, 'A shop', { newName: 'Lidl' })])
    await expect(applyCounterpartyFile(ctx, [row(7, 'B shop', { newName: 'LIDL' })])).rejects.toThrow(/строка 7/)
  })

  it('опознано неверно: признак переходит к выбранному контрагенту (старый закрывается вчера)', async () => {
    const { ctx, storage } = await setup({ withCrypto: true })
    await applyCounterpartyFile(ctx, [row(2, 'X shop', { newName: 'Wrong' }), row(3, 'Y shop', { newName: 'Right' })])
    ctx.now = () => new Date('2026-11-10T10:00:00Z')
    const r = await applyCounterpartyFile(ctx, [row(2, 'X shop', { resolved: 'Right' })])
    expect(r.reassigned).toBe(1)
    const found = await recognizeGroups(ctx, [{ text: 'X shop', iban: null, kind: 'card', rows: 1 }], '2026-11-20')
    expect(found[0]?.name).toBe('Right')
    const old = (await storage.list('counterpartyIdentifiers')).find((i) => i.value === 'X shop' && i.validTo)
    expect(old?.validTo).toBe('2026-11-09')
  })

  it('XLSX: выгрузка, правка, чтение обратно', async () => {
    const { ctx } = await setup({ withCrypto: true })
    await applyCounterpartyFile(ctx, [row(2, 'Lidl dakuje 165-BRATISLAVA', { newName: 'Lidl' })])
    const bytes = await buildCounterpartyWorkbook(ctx, stmt())
    const rows = await readCounterpartyWorkbook(bytes)
    expect(rows.map((r) => [r.row, r.text, r.resolved, r.iban])).toEqual([
      [2, 'Lidl dakuje 165-BRATISLAVA', 'Lidl', null], [3, 'Lidl dakuje 185-BRATISLAVA', '', null], [4, 'Test Sender', '', 'SK0000000000000000000002'],  // порядок по алфавиту
    ])
    const res = await applyCounterpartyFile(ctx, rows.map((r) => (r.row === 3 ? { ...r, resolved: 'Lidl' } : r)))
    expect(res.created).toBe(1)
  })
})
