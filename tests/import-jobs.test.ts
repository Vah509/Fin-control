import { describe, expect, it } from 'vitest'
import {
  addAccountIdentifier, cancelImportJob, createImportJob, getImportJob, listImportableAccounts, listImportJobs,
  setAccountArchived, MAX_COUNTERPARTIES_ALL,
} from '../src/core'
import type { Counterparty, Transaction } from '../src/data/types'
import { code, ID, setup } from './helpers'

const ENTERED = '2026-11-15T10:00:00.000Z'
const tx = (id: string, accountId: string, bookedAt: string, amountMinor: number, counterpartyId: string | null = null): Transaction => ({
  id, accountId, counterpartyId, importId: null, source: 'manual', bookedAt, type: amountMinor < 0 ? 'expense' : 'income',
  amountMinor, currencyKey: accountId === ID.mono ? 'uah' : 'eur', originalAmountMinor: null, originalCurrencyKey: null,
  tagId: null, planType: null, comment: null, transferId: null, dedupeHash: null, deletedAt: null, isOpening: false, raw: null,
  createdBy: null, createdAt: bookedAt, updatedAt: bookedAt,
})

describe('задания на импорт', () => {
  it('выбор счетов: только активные и в режиме «остатки и движения»', async () => {
    const { ctx } = await setup()
    await setAccountArchived(ctx, ID.cashUah, true)
    const keys = (await listImportableAccounts(ctx)).map((a) => a.id)
    expect(keys).toEqual([ID.space, ID.mono])
  })

  it('создаёт задание в статусе «ждёт файла» с пакетом и записью в журнале', async () => {
    const { ctx } = await setup()
    const job = await createImportJob(ctx, { accounts: [{ accountId: ID.mono, balanceMinor: 70126, asOf: ENTERED }] })
    expect(job.status).toBe('waiting_file')
    expect(job.contractVersion).toBe(1)
    expect(job.packageText).toContain(`task_id: ${job.id}`)
    expect(await getImportJob(ctx, job.id)).toEqual(job)
    expect((await ctx.storage.listAudit()).map((a) => a.action)).toContain('import_job_created')
  })

  it('пакет: выбранный счёт полностью, остальные коротко, введённый остаток и местное время', async () => {
    const { ctx } = await setup()
    await ctx.storage.applyBatch({ put: { transactions: [tx('t1', ID.mono, '2026-11-10T08:00:00.000Z', 1000), tx('t2', ID.mono, '2026-11-12T09:30:00.000Z', -250)] } })
    const job = await createImportJob(ctx, { accounts: [{ accountId: ID.mono, balanceMinor: 70126, asOf: ENTERED }] })
    const p = job.packageText
    expect(p).toContain('"key": "mono"')
    expect(p).toContain('"balance": "701.26"')
    expect(p).toContain('"as_of_local": "2026-11-15T12:00:00"')        // Europe/Kyiv, зима UTC+2
    expect(p).toContain('"calculated_balance_now": "7.50"')
    expect(p).toContain('"last_operation_at_local": "2026-11-12T11:30:00"')
    expect(p).toContain('"key":"slsp_space"')                          // остальные счета одной строкой
    expect(p).not.toMatch(/"key": "slsp_space"/)
  })

  it('пакет не содержит полных номеров, только last4', async () => {
    const { ctx } = await setup({ withCrypto: true })
    await addAccountIdentifier(ctx, { accountId: ID.mono, kind: 'account_number', value: 'UA213223130000026007233566001', validFrom: '2020-01-01' })
    const job = await createImportJob(ctx, { accounts: [{ accountId: ID.mono, balanceMinor: 0, asOf: ENTERED }] })
    expect(job.packageText).toContain('"last4": "6001"')
    expect(job.packageText).not.toContain('26007233566')
  })

  it('контрагенты: названия из выписки и свой счёт; при большом числе список сокращается', async () => {
    const { ctx } = await setup()
    const cps: Counterparty[] = [
      { id: 'c1', key: 'lidl', name: 'Lidl', kind: 'shop', accountId: null, defaultTagId: null, defaultPlanType: null },
      { id: 'c2', key: 'own_space', name: 'Мой SPACE', kind: 'own_account', accountId: ID.space, defaultTagId: null, defaultPlanType: null },
    ]
    await ctx.storage.applyBatch({ put: {
      counterparties: cps,
      counterpartyIdentifiers: [{ id: 'i1', counterpartyId: 'c1', kind: 'statement_name', value: 'Lidl dakuje 165', valueHash: null, valueEnc: null, last4: null, validFrom: '2020-01-01', validTo: null }],
    } })
    const p = (await createImportJob(ctx, { accounts: [{ accountId: ID.mono, balanceMinor: 0, asOf: ENTERED }] })).packageText
    expect(p).toContain('"names":["Lidl dakuje 165"]')
    expect(p).toContain('"account":"slsp_space"')

    const many: Counterparty[] = Array.from({ length: MAX_COUNTERPARTIES_ALL + 1 }, (_, i) => ({
      id: `m${i}`, key: `m${i}`, name: `M${i}`, kind: 'shop' as const, accountId: null, defaultTagId: null, defaultPlanType: null,
    }))
    await ctx.storage.applyBatch({ put: { counterparties: many, transactions: [tx('t9', ID.mono, '2026-10-01T10:00:00.000Z', -100, 'm5')] } })
    const q = (await createImportJob(ctx, { accounts: [{ accountId: ID.mono, balanceMinor: 0, asOf: ENTERED }] })).packageText
    expect(q).toContain('список сокращён')
    expect(q).toContain('"key":"m5"')
    expect(q).not.toContain('"key":"m6"')
    expect(q).toContain('"key":"own_space"')
  })

  it('проверки при создании', async () => {
    const { ctx } = await setup()
    const ok = { accountId: ID.mono, balanceMinor: 1, asOf: ENTERED }
    expect(await code(createImportJob(ctx, { accounts: [] }))).toBe('INVALID_FIELD')
    expect(await code(createImportJob(ctx, { accounts: [ok, ok] }))).toBe('INVALID_FIELD')
    expect(await code(createImportJob(ctx, { accounts: [{ ...ok, accountId: 'nope' }] }))).toBe('NOT_FOUND')
    expect(await code(createImportJob(ctx, { accounts: [{ ...ok, accountId: ID.parents }] }))).toBe('INVALID_FIELD')   // только остатки
    expect(await code(createImportJob(ctx, { accounts: [{ ...ok, asOf: 'вчера' }] }))).toBe('INVALID_DATE')
    expect(await code(createImportJob(ctx, { accounts: [{ ...ok, balanceMinor: 1.5 }] }))).toBe('INVALID_AMOUNT')
    await setAccountArchived(ctx, ID.mono, true)
    expect(await code(createImportJob(ctx, { accounts: [ok] }))).toBe('ACCOUNT_ARCHIVED')
    expect(await listImportJobs(ctx)).toHaveLength(0)
  })

  it('только владелец', async () => {
    const { ctx } = await setup({ owner: false })
    expect(await code(createImportJob(ctx, { accounts: [{ accountId: ID.mono, balanceMinor: 1, asOf: ENTERED }] }))).toBe('FORBIDDEN')
  })

  it('отмена: допустима в «ждёт файла», затем повторно нельзя; список новые сверху', async () => {
    const { ctx, clock } = await setup()
    const a = await createImportJob(ctx, { accounts: [{ accountId: ID.mono, balanceMinor: 1, asOf: ENTERED }] })
    clock.t += 60_000
    const b = await createImportJob(ctx, { accounts: [{ accountId: ID.space, balanceMinor: 1, asOf: ENTERED }] })
    expect((await listImportJobs(ctx)).map((j) => j.id)).toEqual([b.id, a.id])
    expect((await cancelImportJob(ctx, a.id)).status).toBe('cancelled')
    expect(await code(cancelImportJob(ctx, a.id))).toBe('INVALID_STATE')
    expect(await code(cancelImportJob(ctx, 'nope'))).toBe('NOT_FOUND')
    expect((await ctx.storage.listAudit()).map((x) => x.action)).toContain('import_job_cancelled')
  })
})
