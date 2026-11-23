import { writeFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { parseSlspStatement, reconcileAccount } from '../../src/core/statements'
import { SCENARIOS, scenarioPages } from './scenarios'

describe('тестовые выписки для ручной проверки', () => {
  for (const s of SCENARIOS) {
    it(`${s.file}: разбирается, сверка сходится`, () => {
      const st = parseSlspStatement(scenarioPages(s))
      expect(st.accounts).toHaveLength(1)
      expect(reconcileAccount(st.accounts[0]!).ok).toBe(true)
      if (process.env.DUMP_SCENARIOS) writeFileSync(`/tmp/${s.file}.json`, JSON.stringify(scenarioPages(s)))
    })
  }
})
