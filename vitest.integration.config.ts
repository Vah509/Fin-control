import { defineConfig } from 'vitest/config'

// Интеграционные тесты против ТЕСТОВОГО проекта Supabase. Не входят в обычный `npm test`.
export default defineConfig({
  test: { environment: 'node', include: ['tests/integration/**/*.int.ts'], testTimeout: 30000 },
})
