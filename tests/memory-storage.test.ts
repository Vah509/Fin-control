import { MemoryStorage } from '../src/data/memory/memoryStorage'
import { runStorageContract } from './storage-contract'

runStorageContract('memory', async () => new MemoryStorage())
