import { describe, expect, it } from 'vitest'
import { parseSlspStatement } from '../../src/core/statements'
import { confirmAccountsRecognized, createStatementTask, identifyStatementAccount, taskAccountsStatus } from '../../src/core'
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
  return { ...t, st, task }
}


describe('шаг 2: опознание счёта', () => {
  it('счёт неопознан: «следующий шаг» отказывает; сохранение признака (4 цифры) опознаёт; валюта должна совпасть', async () => {
    const { ctx, task, storage } = await prepared({ identifier: false })
    expect((await taskAccountsStatus(ctx, task.id)).map((x) => [x.key, x.account])).toEqual([['0001', null]])
    await expect(confirmAccountsRecognized(ctx, task.id)).rejects.toThrow(/счёт неопознан: …0001/)
    await expect(identifyStatementAccount(ctx, task.id, '0001', ID.cashUah)).rejects.toThrow(/валюта счёта/)
    const st = await identifyStatementAccount(ctx, task.id, '0001', ID.space)
    expect(st[0]!.account).toMatchObject({ id: ID.space })
    expect((await storage.listAccountIdentifiers({ accountId: ID.space }))[0]).toMatchObject({ kind: 'account_number', last4: '0001' })
    await expect(identifyStatementAccount(ctx, task.id, '0001', ID.space)).rejects.toThrow(/уже опознан/)
    const t = await confirmAccountsRecognized(ctx, task.id)
    expect(t.state).toMatchObject({ accountsConfirmed: true })
  })
})
