import { MemoryStorage } from '../src/data/memory/memoryStorage'
import { runStorageContract } from './storage-contract'

runStorageContract('memory', async () => {
  let n = 0
  return {
    storage: new MemoryStorage(), a1: 'a1', a2: 'a2', newId: () => `id-${++n}`, userId: 'u1',
    supportsReplace: true, token: 'tok',
  }
})
