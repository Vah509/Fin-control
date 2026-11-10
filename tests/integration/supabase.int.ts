// Контрактные тесты Supabase-хранилища против тестового проекта. Запуск: npm run test:supabase
// Переменные окружения (в терминале, не в git): TEST_SUPABASE_URL, TEST_SUPABASE_ANON_KEY, TEST_USER_EMAIL, TEST_USER_PASSWORD.
// Пользователь должен быть владельцем (строки account_access с ролью owner) и миграции итераций 1-3 применены.
// Тест создаёт два служебных счёта contract_a1 и contract_a2 (фиксированные id; повторный запуск безопасен)
// и перед каждым тестом удаляет их операции. Записи журнала и контрольные точки остаются (журнал только дописывается).
import { afterAll, beforeAll, describe, it } from 'vitest'
import { createClient } from '@supabase/supabase-js'
import { SupabaseStorage } from '../../src/data/supabase'
import { runStorageContract, type ContractEnv } from '../storage-contract'

const { TEST_SUPABASE_URL: URL_, TEST_SUPABASE_ANON_KEY: KEY, TEST_USER_EMAIL: EMAIL, TEST_USER_PASSWORD: PASS } = process.env
const A1 = '00000000-0000-4000-8000-0000000c0a01'
const A2 = '00000000-0000-4000-8000-0000000c0a02'

if (!URL_ || !KEY || !EMAIL || !PASS) {
  describe('контракт хранилища: supabase', () => {
    it.skip('нет TEST_SUPABASE_URL / TEST_SUPABASE_ANON_KEY / TEST_USER_EMAIL / TEST_USER_PASSWORD', () => {})
  })
} else {
  const db = createClient(URL_, KEY, { auth: { persistSession: false } })
  const storage = new SupabaseStorage(db)
  let userId = ''

  beforeAll(async () => {
    const { data, error } = await db.auth.signInWithPassword({ email: EMAIL, password: PASS })
    if (error || !data.user) throw new Error(`вход не удался: ${error?.message}`)
    userId = data.user.id
    const projects = await storage.list('projects')
    const countries = await storage.list('countries')
    const eur = (await storage.list('currencies')).find((c) => c.key === 'eur') ?? (() => { throw new Error('в базе нет валюты eur (загрузите seed)') })()
    if (!projects[0] || !countries[0]) throw new Error('в базе нет проекта или страны (загрузите seed)')
    const acc = (id: string, key: string) => ({
      id, key, name: key, type: 'bank' as const, institutionId: null, projectId: projects[0]!.id, holder: null,
      currencyKey: eur.key, countryKey: countries[0]!.key, timezone: null, trackingMode: 'balance_and_movements' as const,
      servicePercent: null, appearance: {}, sortOrder: 999, archivedAt: '2026-01-01T00:00:00.000Z',
    })
    await storage.applyBatch({ put: { accounts: [acc(A1, 'contract_a1'), acc(A2, 'contract_a2')] } })
  })
  afterAll(async () => { await db.auth.signOut() })

  runStorageContract('supabase', async (): Promise<ContractEnv> => {
    const old = await storage.listTransactions({ accountIds: [A1, A2], includeDeleted: true })
    if (old.length) await storage.applyBatch({ deleteTransactionIds: old.map((t) => t.id) })
    storage.resetCache()
    return {
      storage, a1: A1, a2: A2, newId: () => crypto.randomUUID(), userId, supportsReplace: false,
      token: `it${Date.now().toString(36)}`,
    }
  })
}
