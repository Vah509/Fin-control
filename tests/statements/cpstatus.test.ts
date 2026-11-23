import { describe, expect, it } from 'vitest'
import { applyCounterpartyFile, collectCounterpartyGroups, counterpartyStatus, parseSlspStatement } from '../../src/core/statements'
import { compareTask, confirmCounterpartiesRecognized, createStatementTask, saveComparison } from '../../src/core'
import type { Counterparty, Transaction } from '../../src/data/types'
import { ID, setup } from '../helpers'
import { buildSlsp } from './slspFixture'

const stmt = (tamper = false) => parseSlspStatement(buildSlsp({
  opening: '1 000,00', deposits: '500,00', withdrawals: '- 30,00', closing: tamper ? '1 471,00' : '1 470,00',
  pages: [[
    { dates: '03.09.2026 03.09.2026', lines: ['Platba kartou', 'Č. k. 1111 22** **** 3333', 'Shop A-BRATISLAVA 01. 09. 2026 10:00:00', 'Transakcia prostredníctvom GooglePay'], amount: '- 10,00', balance: '990,00' },
    { dates: '05.09.2026 05.09.2026', lines: ['Platba kartou', 'Č. k. 1111 22** **** 3333', 'Shop B-BRATISLAVA 03. 09. 2026 12:00:00', 'Transakcia prostredníctvom GooglePay'], amount: '- 20,00', balance: '970,00' },
    { dates: '06.09.2026 06.09.2026', lines: ['Prijatá SEPA platba', 'SK00 0000 0000 0000 0000 0002 BIC: TESTSKBX', 'Názov protiúčtu: Test Sender'], amount: '500,00', balance: '1 470,00' },
  ]],
}))
async function prepared(opts: { identifier?: boolean; txs?: Transaction[]; senderAccountId?: string | null; tamper?: boolean } = {}) {
  const t = await setup({ withCrypto: true })
  const st = stmt(opts.tamper)
  const put: Record<string, unknown[]> = { transactions: opts.txs ?? [] }
  if (opts.identifier !== false) put.accountIdentifiers = [{ id: 'i1', accountId: ID.space, kind: 'account_number', valueHash: 'h', valueEnc: 'e', last4: st.accounts[0]!.key, validFrom: '2020-01-01', validTo: null }]
  if (opts.senderAccountId !== undefined) {
    const cp: Counterparty = { id: 'cp-own', key: 'own', name: 'Свой: Test Sender', kind: 'own_account', accountId: opts.senderAccountId, defaultTagId: null, defaultPlanType: null }
    put.counterparties = [cp]
    put.counterpartyIdentifiers = [{ id: 'ci1', counterpartyId: 'cp-own', kind: 'statement_name', value: 'Test Sender', valueHash: null, valueEnc: null, last4: null, validFrom: '2020-01-01', validTo: null }]
  }
  await t.storage.applyBatch({ put } as never)
  const task = await createStatementTask(t.ctx, st, 'a.pdf')
  await saveComparison(t.ctx, task.id, await compareTask(t.ctx, task.id))
  return { ...t, st, task }
}


describe('шаг 2: статус опознания контрагентов', () => {
  it('считает опознанных и не опознанных; «продолжить» без файла только когда опознаны все', async () => {
    const { ctx, st, task, storage } = await prepared({ senderAccountId: null })
    // в справочнике только Test Sender: Shop A и Shop B не опознаны
    let c = await counterpartyStatus(ctx, st)
    expect([c.total, c.recognized, c.unrecognized.map((g) => g.text)]).toEqual([3, 1, ['Shop A-BRATISLAVA', 'Shop B-BRATISLAVA']])
    await expect(confirmCounterpartiesRecognized(ctx, task.id)).rejects.toThrow(/не опознано контрагентов: 2/)
    await applyCounterpartyFile(ctx, collectCounterpartyGroups(st).filter((g) => g.kind === 'card').map((g, i) => ({ row: i + 2, text: g.text, resolved: '', newName: g.text.split('-')[0]!, iban: null })))
    c = await counterpartyStatus(ctx, st)
    expect([c.total, c.recognized, c.unrecognized.length]).toEqual([3, 3, 0])
    const t = await confirmCounterpartiesRecognized(ctx, task.id)
    expect(t.state).toMatchObject({ counterpartiesLoaded: true, counterpartiesFile: 'без файла: все опознаны' })
    expect(await storage.list('counterparties')).toHaveLength(3)
  })
})
