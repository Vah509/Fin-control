import { describe, expect, it } from 'vitest'
import { createStatementTask, deleteStatementTask, listStatementTasks, maskStatement, taskStatement, updateTaskState } from '../src/core'
import { applyCounterpartyFile, buildCounterpartyWorkbook, parseSlspStatement, readCounterpartyWorkbook } from '../src/core/statements'
import { setup } from './helpers'
import { buildSlsp } from './statements/slspFixture'

const stmt = () => parseSlspStatement(buildSlsp({
  opening: '1 000,00', deposits: '500,00', withdrawals: '- 10,00', closing: '1 490,00',
  pages: [[
    { dates: '04.09.2026 04.09.2026', lines: ['Platba kartou', 'Č. k. 1111 22** **** 3333', 'Lidl dakuje 165-BRATISLAVA 02. 09. 2026 17:10:34', 'Transakcia prostredníctvom GooglePay'], amount: '- 10,00', balance: '990,00' },
    { dates: '06.09.2026 06.09.2026', lines: ['Prijatá SEPA platba', 'SK00 0000 0000 0000 0000 0002 BIC: TESTSKBX', 'Názov protiúčtu: Test Sender'], amount: '500,00', balance: '1 490,00' },
  ]],
}))

describe('задачи выписок', () => {
  it('в базу идёт выписка без полных номеров', () => {
    const m = maskStatement(stmt())
    const json = JSON.stringify(m)
    expect(json).not.toMatch(/SK00 ?0000/)
    expect(m.accounts[0]!.number).toMatch(/^IBAN…\d{4}$/)
    expect(m.accounts[0]!.rows.every((r) => r.counterparty.iban === null)).toBe(true)
  })

  it('создание, список, шаги, удаление', async () => {
    const { ctx, storage } = await setup()
    const t = await createStatementTask(ctx, stmt(), 'vypis.pdf')
    expect(t.title).toContain('vypis.pdf')
    expect((await listStatementTasks(ctx)).map((x) => x.id)).toEqual([t.id])
    expect(taskStatement((await listStatementTasks(ctx))[0]!).accounts[0]!.rows).toHaveLength(2)
    await updateTaskState(ctx, t.id, { counterpartiesLoaded: true })
    expect(((await listStatementTasks(ctx))[0]!.state as { counterpartiesLoaded: boolean }).counterpartiesLoaded).toBe(true)
    await updateTaskState(ctx, t.id, { operationsDone: true })
    expect((await listStatementTasks(ctx))[0]!.status).toBe('done')
    await deleteStatementTask(ctx, t.id)
    expect(await listStatementTasks(ctx)).toEqual([])
    expect((await storage.list('statementTasks'))[0]!.payload).toBeNull()
  })

  it('без ключей шифрования: файл контрагентов работает по названиям (из сохранённой задачи)', async () => {
    const { ctx } = await setup()
    const t = await createStatementTask(ctx, stmt(), 'v.pdf')
    const rows = await readCounterpartyWorkbook(await buildCounterpartyWorkbook(ctx, taskStatement(t)))
    expect(rows).toHaveLength(2)
    const r = await applyCounterpartyFile(ctx, rows)
    expect(r).toMatchObject({ created: 2, identifiersAdded: 2 })
    const again = await readCounterpartyWorkbook(await buildCounterpartyWorkbook(ctx, taskStatement(t)))
    expect(again.every((x) => x.resolved)).toBe(true)
  })
})
