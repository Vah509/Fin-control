import { describe, expect, it } from 'vitest'
import { parseSlspStatement } from '../../src/core/statements'
import { createStatementTask, deleteStatementDocument, saveStatementFromTask, updateTaskState, rowKeyOf } from '../../src/core'
import { ID, setup } from '../helpers'
import { buildSlsp } from './slspFixture'

const A = { dates: '03.09.2026 03.09.2026', lines: ['Platba kartou', 'Č. k. 1111 22** **** 3333', 'Shop A-BRATISLAVA 01. 09. 2026 10:00:00'], amount: '- 10,00', balance: '990,00' }
const B = { dates: '05.09.2026 05.09.2026', lines: ['Platba kartou', 'Č. k. 1111 22** **** 3333', 'Shop B-BRATISLAVA 03. 09. 2026 12:00:00'], amount: '- 20,00', balance: '970,00' }
const C = { dates: '08.09.2026 08.09.2026', lines: ['Platba kartou', 'Č. k. 1111 22** **** 3333', 'Shop C-BRATISLAVA 07. 09. 2026 12:00:00'], amount: '- 5,00', balance: '965,00' }
const first = () => parseSlspStatement(buildSlsp({ opening: '1 000,00', deposits: '0,00', withdrawals: '- 30,00', closing: '970,00', pages: [[A, B]] }))
// пересекающаяся выписка: строка B повторяется (баланс сохранён цепочкой), добавлена C
const second = () => parseSlspStatement(buildSlsp({ opening: '990,00', deposits: '0,00', withdrawals: '- 25,00', closing: '965,00', pages: [[B, C]] }))

async function prepared() {
  const t = await setup({ withCrypto: true })
  await t.storage.applyBatch({ put: { accountIdentifiers: [{ id: 'i1', accountId: ID.space, kind: 'account_number', valueHash: 'h', valueEnc: 'e', last4: first().accounts[0]!.key, validFrom: '2020-01-01', validTo: null }] } } as never)
  return t
}
const taskOf = async (t: Awaited<ReturnType<typeof prepared>>, st: ReturnType<typeof first>, name: string) => {
  const task = await createStatementTask(t.ctx, st, name)
  await updateTaskState(t.ctx, task.id, { counterpartiesLoaded: true })
  return task
}

describe('выписки как документы (этап 1)', () => {
  it('сохраняет документ без записи операций в учёт и закрывает задачу', async () => {
    const t = await prepared()
    const before = (await t.storage.listTransactions({})).length
    const r = await saveStatementFromTask(t.ctx, (await taskOf(t, first(), 'a.pdf')).id)
    expect(r.rows).toBe(2); expect(r.duplicates).toBe(0)
    expect((await t.storage.listTransactions({})).length).toBe(before)
    const accs = await t.storage.list('statementAccounts')
    expect(accs).toHaveLength(1)
    expect(accs[0]).toMatchObject({ openingMinor: 100000, closingMinor: 97000, rowCount: 2, builtInAt: null })
    expect((await t.storage.list('statementTasks'))[0]!.status).toBe('done')
  })

  it('повторное содержимое и полностью повторяющаяся выписка отклоняются', async () => {
    const t = await prepared()
    await saveStatementFromTask(t.ctx, (await taskOf(t, first(), 'a.pdf')).id)
    await expect(saveStatementFromTask(t.ctx, (await taskOf(t, first(), 'b.pdf')).id)).rejects.toMatchObject({ code: 'DUPLICATE_STATEMENT' })
  })

  it('частичное пересечение: сохраняется целиком, у дубля ссылка на оригинал; удаление оригинала снимает пометку', async () => {
    const t = await prepared()
    const d1 = (await saveStatementFromTask(t.ctx, (await taskOf(t, first(), 'a.pdf')).id)).document
    const r2 = await saveStatementFromTask(t.ctx, (await taskOf(t, second(), 'b.pdf')).id)
    expect(r2.rows).toBe(2); expect(r2.duplicates).toBe(1)
    const rows = await t.storage.list('statementRows')
    const dup = rows.find((r) => r.duplicateOf)!
    expect(rows.find((r) => r.id === dup.duplicateOf)!.documentId).toBe(d1.id)
    await deleteStatementDocument(t.ctx, d1.id)
    expect((await t.storage.list('statementRows')).every((r) => r.duplicateOf === null)).toBe(true)
    expect(await t.storage.list('statementDocuments')).toHaveLength(1)
  })

  it('встроенный документ удалить нельзя; ключ строки не зависит от номера в выписке', async () => {
    const t = await prepared()
    const d = (await saveStatementFromTask(t.ctx, (await taskOf(t, first(), 'a.pdf')).id)).document
    const acc = (await t.storage.list('statementAccounts'))[0]!
    await t.storage.applyBatch({ put: { statementAccounts: [{ ...acc, builtInAt: '2026-11-27T00:00:00.000Z' }] } })
    await expect(deleteStatementDocument(t.ctx, d.id)).rejects.toMatchObject({ code: 'DOCUMENT_BUILT_IN' })
    expect(await rowKeyOf('a', '2026-09-03', -1000, 0, 'EUR', 'Shop  A', 1)).toBe(await rowKeyOf('a', '2026-09-03', -1000, 0, 'EUR', 'shop a', 1))
  })
})
