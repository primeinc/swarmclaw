/**
 * Cosmos DB storage backend — in-memory cache with async write-behind.
 *
 * Activated by STORAGE_BACKEND=cosmos. All reads are served from in-memory
 * Maps (zero latency). Writes update memory synchronously, then enqueue
 * an async Cosmos write that flushes in the background.
 *
 * Requires: @azure/cosmos ^4.3.0, @azure/identity ^4.5.0
 * Auth: DefaultAzureCredential (managed identity via AZURE_CLIENT_ID)
 */

import type { StorageBackend, LockInfo } from './storage-backend'
import type { Container, OperationInput, BulkOperationResult, JSONObject } from '@azure/cosmos'
import { log } from '@/lib/server/logger'

const TAG = 'storage-cosmos'

// ── Write-behind queue ─────────────────────────────────────────────────────

interface PendingWrite {
  type: 'upsert' | 'delete'
  container: 'collections' | 'usage'
  partitionKey: string
  id: string
  body?: Record<string, unknown>
}

class WriteBehindQueue {
  private queue: PendingWrite[] = []
  private flushing = false
  private timer: ReturnType<typeof setTimeout> | null = null
  private flushFn: (ops: PendingWrite[]) => Promise<void>

  constructor(flushFn: (ops: PendingWrite[]) => Promise<void>) {
    this.flushFn = flushFn
  }

  enqueue(op: PendingWrite): void {
    this.queue.push(op)
    if (!this.timer) {
      this.timer = setTimeout(() => { void this.flush() }, 200)
    }
    // Flush immediately if batch is large enough
    if (this.queue.length >= 50 && !this.flushing) {
      void this.flush()
    }
  }

  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    if (this.flushing || this.queue.length === 0) return

    this.flushing = true
    const batch = this.queue.splice(0)

    try {
      await this.flushFn(batch)
    } catch (err) {
      log.error(TAG, `Write-behind flush failed (${batch.length} ops):`, err)
      // Re-queue failed ops at the front for retry
      this.queue.unshift(...batch)
      // Back off before retrying
      this.timer = setTimeout(() => { void this.flush() }, 2000)
    } finally {
      this.flushing = false
    }

    // If more ops arrived while flushing, schedule another flush
    if (this.queue.length > 0 && !this.timer) {
      this.timer = setTimeout(() => { void this.flush() }, 200)
    }
  }

  async drain(): Promise<void> {
    // Keep flushing until queue is empty
    let attempts = 0
    while (this.queue.length > 0 && attempts < 10) {
      await this.flush()
      if (this.queue.length > 0) {
        await new Promise(r => setTimeout(r, 500))
      }
      attempts++
    }
    if (this.queue.length > 0) {
      log.error(TAG, `Failed to drain write queue after ${attempts} attempts, ${this.queue.length} ops remaining`)
    }
  }
}

// ── Lock TTL helper ────────────────────────────────────────────────────────

function normalizeLockTtlMs(ttlMs: number): number {
  if (!Number.isFinite(ttlMs)) return 1_000
  return Math.max(1_000, Math.trunc(ttlMs))
}

// ── Backend implementation ─────────────────────────────────────────────────

export function createCosmosMemoryBackend(options?: {
  endpoint?: string
  databaseName?: string
  key?: string
}): StorageBackend {
  const endpoint = options?.endpoint ?? process.env.COSMOS_ENDPOINT
  const databaseName = options?.databaseName ?? process.env.COSMOS_DATABASE ?? 'swarmclaw'
  const cosmosKey = options?.key ?? process.env.COSMOS_KEY

  if (!endpoint) {
    throw new Error(
      'COSMOS_ENDPOINT is required when STORAGE_BACKEND=cosmos. ' +
      'Set it to your Cosmos DB account endpoint (e.g., https://cosmos-xxx.documents.azure.com:443/)',
    )
  }

  // ── In-memory state ──────────────────────────────────────────────────
  // collections: table → (id → JSON string)
  const collections = new Map<string, Map<string, string>>()
  // singletons: key → JSON string
  const singletons = new Map<string, string>()
  // usage: sessionId → JSON string[]
  const usageData = new Map<string, string[]>()
  // locks: name → LockInfo
  const locks = new Map<string, LockInfo>()

  function getOrCreateCollection(table: string): Map<string, string> {
    let col = collections.get(table)
    if (!col) {
      col = new Map()
      collections.set(table, col)
    }
    return col
  }

  // ── Cosmos client (lazy init) ────────────────────────────────────────
  let _collectionsContainer: Container | null = null
  let _usageContainer: Container | null = null

  async function getContainers(): Promise<{ collections: Container; usage: Container }> {
    if (_collectionsContainer && _usageContainer) {
      return { collections: _collectionsContainer, usage: _usageContainer }
    }

    const { CosmosClient } = await import('@azure/cosmos')

    // Key auth for emulator/dev, AAD auth for production
    let client: InstanceType<typeof CosmosClient>
    if (cosmosKey) {
      log.info(TAG, 'Using key-based auth (emulator/dev mode)')
      client = new CosmosClient({ endpoint: endpoint!, key: cosmosKey })
    } else {
      const { DefaultAzureCredential } = await import('@azure/identity')
      log.info(TAG, 'Using AAD/DefaultAzureCredential auth (production)')
      client = new CosmosClient({ endpoint: endpoint!, aadCredentials: new DefaultAzureCredential() })
    }

    if (cosmosKey) {
      // Emulator/dev: create database and containers if they don't exist.
      // The emulator starts empty — no Bicep to pre-provision resources.
      const { database: db } = await client.databases.createIfNotExists({ id: databaseName })
      const { container: collContainer } = await db.containers.createIfNotExists({
        id: 'collections',
        partitionKey: { paths: ['/collection'] },
      })
      const { container: usageContainer } = await db.containers.createIfNotExists({
        id: 'usage',
        partitionKey: { paths: ['/sessionId'] },
      })
      _collectionsContainer = collContainer
      _usageContainer = usageContainer
    } else {
      // Production: database and containers are pre-created by Bicep.
      // MSI has Data Contributor role (data-plane only) — calling
      // createIfNotExists would require account-level Contributor and fail with 403.
      const db = client.database(databaseName)
      _collectionsContainer = db.container('collections')
      _usageContainer = db.container('usage')
    }

    return { collections: _collectionsContainer, usage: _usageContainer }
  }

  // ── Write-behind flush ───────────────────────────────────────────────

  function toOperationInput(op: PendingWrite): OperationInput {
    if (op.type === 'delete') {
      return {
        operationType: 'Delete',
        id: op.id,
        partitionKey: op.partitionKey,
      }
    }
    return {
      operationType: 'Upsert',
      partitionKey: op.partitionKey,
      resourceBody: op.body as JSONObject,
    }
  }

  function checkBulkResults(results: BulkOperationResult[]): void {
    for (const result of results) {
      const status = result.response?.statusCode ?? 0
      if (status >= 400 && status !== 404) {
        log.error(TAG, `Bulk operation failed: status=${status} op=${JSON.stringify(result.operationInput)}`)
      }
    }
  }

  async function flushBulkOps(container: Container, ops: OperationInput[]): Promise<void> {
    for (let i = 0; i < ops.length; i += 100) {
      const chunk = ops.slice(i, i + 100)
      const results = await container.items.executeBulkOperations(chunk)
      checkBulkResults(results)
    }
  }

  async function flushWrites(ops: PendingWrite[]): Promise<void> {
    const containers = await getContainers()

    const collectionOps: OperationInput[] = []
    const usageOps: OperationInput[] = []
    for (const op of ops) {
      const input = toOperationInput(op)
      if (op.container === 'collections') collectionOps.push(input)
      else usageOps.push(input)
    }

    if (collectionOps.length > 0) {
      await flushBulkOps(containers.collections, collectionOps)
    }
    if (usageOps.length > 0) {
      await flushBulkOps(containers.usage, usageOps)
    }
  }

  const writeQueue = new WriteBehindQueue(flushWrites)

  // ── Enqueue helpers ──────────────────────────────────────────────────

  function enqueueCollectionUpsert(table: string, id: string, json: string): void {
    writeQueue.enqueue({
      type: 'upsert',
      container: 'collections',
      partitionKey: table,
      id,
      body: { id, collection: table, data: json },
    })
  }

  function enqueueCollectionDelete(table: string, id: string): void {
    writeQueue.enqueue({
      type: 'delete',
      container: 'collections',
      partitionKey: table,
      id,
    })
  }

  function enqueueSingletonUpsert(key: string, json: string): void {
    writeQueue.enqueue({
      type: 'upsert',
      container: 'collections',
      partitionKey: '__singletons',
      id: key,
      body: { id: key, collection: '__singletons', data: json },
    })
  }

  function enqueueUsageAppend(sessionId: string, docId: string, json: string): void {
    writeQueue.enqueue({
      type: 'upsert',
      container: 'usage',
      partitionKey: sessionId,
      id: docId,
      body: { id: docId, sessionId, data: json },
    })
  }

  function enqueueLockUpsert(name: string, info: LockInfo): void {
    const ttlSec = Math.ceil(Math.max(1000, info.expiresAt - Date.now()) / 1000)
    writeQueue.enqueue({
      type: 'upsert',
      container: 'collections',
      partitionKey: '__locks',
      id: `__lock_${name}`,
      body: {
        id: `__lock_${name}`,
        collection: '__locks',
        data: JSON.stringify(info),
        ttl: ttlSec,
      },
    })
  }

  function enqueueLockDelete(name: string): void {
    writeQueue.enqueue({
      type: 'delete',
      container: 'collections',
      partitionKey: '__locks',
      id: `__lock_${name}`,
    })
  }

  // ── Backend ──────────────────────────────────────────────────────────

  const backend: StorageBackend = {
    readCollectionRaw(table: string): Map<string, string> {
      return new Map(getOrCreateCollection(table))
    },

    readItem(table: string, id: string): string | null {
      return getOrCreateCollection(table).get(id) ?? null
    },

    upsertItem(table: string, id: string, json: string): void {
      getOrCreateCollection(table).set(id, json)
      enqueueCollectionUpsert(table, id, json)
    },

    upsertItems(table: string, entries: Array<[string, string]>): void {
      const col = getOrCreateCollection(table)
      for (const [id, json] of entries) {
        col.set(id, json)
        enqueueCollectionUpsert(table, id, json)
      }
    },

    deleteItem(table: string, id: string): void {
      getOrCreateCollection(table).delete(id)
      enqueueCollectionDelete(table, id)
    },

    saveCollection(table: string, toUpsert: Array<[string, string]>, toDelete: string[]): void {
      const col = getOrCreateCollection(table)
      for (const id of toDelete) {
        col.delete(id)
        enqueueCollectionDelete(table, id)
      }
      for (const [id, json] of toUpsert) {
        col.set(id, json)
        enqueueCollectionUpsert(table, id, json)
      }
    },

    readSingleton(key: string): string | null {
      return singletons.get(key) ?? null
    },

    writeSingleton(key: string, json: string): void {
      singletons.set(key, json)
      enqueueSingletonUpsert(key, json)
    },

    appendUsage(sessionId: string, json: string): void {
      let records = usageData.get(sessionId)
      if (!records) {
        records = []
        usageData.set(sessionId, records)
      }
      records.push(json)
      const docId = `${sessionId}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
      enqueueUsageAppend(sessionId, docId, json)
    },

    readAllUsage(): Array<{ session_id: string; data: string }> {
      const result: Array<{ session_id: string; data: string }> = []
      for (const [sessionId, records] of usageData) {
        for (const data of records) {
          result.push({ session_id: sessionId, data })
        }
      }
      return result
    },

    pruneOldUsage(maxAgeMs: number): number {
      const cutoff = Date.now() - maxAgeMs
      let pruned = 0
      for (const [sessionId, records] of usageData) {
        const kept: string[] = []
        for (const json of records) {
          try {
            const parsed = JSON.parse(json) as Record<string, unknown>
            const ts = typeof parsed.timestamp === 'number' ? parsed.timestamp : 0
            if (ts >= cutoff) {
              kept.push(json)
            } else {
              pruned++
            }
          } catch {
            kept.push(json) // keep malformed records
          }
        }
        if (kept.length === 0) {
          usageData.delete(sessionId)
        } else {
          usageData.set(sessionId, kept)
        }
      }
      // Note: we don't enqueue individual deletes for pruned usage records.
      // The in-memory state is authoritative; Cosmos TTL or periodic sync handles cleanup.
      return pruned
    },

    getUsageSpendSince(minTimestamp: number): number {
      let total = 0
      for (const records of usageData.values()) {
        for (const json of records) {
          try {
            const parsed = JSON.parse(json) as Record<string, unknown>
            const ts = typeof parsed.timestamp === 'number' ? parsed.timestamp : 0
            if (ts < minTimestamp) continue
            const cost = typeof parsed.estimatedCost === 'number' ? parsed.estimatedCost : 0
            if (Number.isFinite(cost) && cost > 0) total += cost
          } catch {
            // skip malformed
          }
        }
      }
      return total
    },

    // ── Locks ────────────────────────────────────────────────────

    tryAcquireLock(name: string, owner: string, ttlMs: number): boolean {
      const now = Date.now()
      const expiresAt = now + normalizeLockTtlMs(ttlMs)
      const existing = locks.get(name)

      if (existing && existing.owner !== owner && existing.expiresAt > now) {
        return false
      }

      const info: LockInfo = { owner, expiresAt, updatedAt: now }
      locks.set(name, info)
      enqueueLockUpsert(name, info)
      return true
    },

    renewLock(name: string, owner: string, ttlMs: number): boolean {
      const existing = locks.get(name)
      if (!existing || existing.owner !== owner) return false

      const now = Date.now()
      const expiresAt = now + normalizeLockTtlMs(ttlMs)
      const info: LockInfo = { owner, expiresAt, updatedAt: now }
      locks.set(name, info)
      enqueueLockUpsert(name, info)
      return true
    },

    readLock(name: string): LockInfo | null {
      return locks.get(name) ?? null
    },

    isLockActive(name: string): boolean {
      const lock = locks.get(name)
      return lock !== null && lock !== undefined && lock.expiresAt > Date.now()
    },

    releaseLock(name: string, owner: string): void {
      const existing = locks.get(name)
      if (existing && existing.owner === owner) {
        locks.delete(name)
        enqueueLockDelete(name)
      }
    },

    pruneExpiredLocks(): number {
      // Cosmos TTL handles this automatically. Just clean up in-memory.
      const now = Date.now()
      let pruned = 0
      for (const [name, info] of locks) {
        if (info.expiresAt <= now) {
          locks.delete(name)
          pruned++
        }
      }
      return pruned
    },

    // ── Queries ──────────────────────────────────────────────────

    queryByJsonField(table: string, fieldPath: string, value: string, orderByField?: string): string[] {
      const col = getOrCreateCollection(table)
      const field = fieldPath.replace('$.', '')
      const orderField = orderByField?.replace('$.', '')

      const results: Array<{ json: string; sortVal: unknown }> = []
      for (const json of col.values()) {
        try {
          const parsed = JSON.parse(json) as Record<string, unknown>
          if (String(parsed[field]) === value) {
            results.push({
              json,
              sortVal: orderField ? parsed[orderField] : 0,
            })
          }
        } catch {
          // skip malformed
        }
      }

      if (orderField) {
        results.sort((a, b) => {
          if (typeof a.sortVal === 'number' && typeof b.sortVal === 'number') {
            return a.sortVal - b.sortVal
          }
          return String(a.sortVal).localeCompare(String(b.sortVal))
        })
      }

      return results.map(r => r.json)
    },

    countItems(table: string): number {
      return getOrCreateCollection(table).size
    },

    bulkUpdate(table: string, updater: (id: string, json: string) => string | null): number {
      const col = getOrCreateCollection(table)
      let changed = 0
      for (const [id, json] of col) {
        const newJson = updater(id, json)
        if (newJson !== null) {
          col.set(id, newJson)
          enqueueCollectionUpsert(table, id, newJson)
          changed++
        }
      }
      return changed
    },

    // ── Transactions ─────────────────────────────────────────────

    withTransaction<T>(fn: () => T): T {
      // Node.js is single-threaded — in-memory operations are atomic.
      return fn()
    },

    // ── Lifecycle ────────────────────────────────────────────────

    async initialize(): Promise<void> {
      log.info(TAG, `Initializing Cosmos backend (endpoint: ${endpoint}, db: ${databaseName})`)
      const containers = await getContainers()

      // Load all collections
      log.info(TAG, 'Loading collections from Cosmos...')
      const { resources: collDocs } = await containers.collections.items
        .query('SELECT c.id, c.collection, c.data FROM c WHERE c.collection != "__singletons" AND c.collection != "__locks"')
        .fetchAll()

      for (const doc of collDocs) {
        const table = doc.collection as string
        const col = getOrCreateCollection(table)
        col.set(doc.id as string, doc.data as string)
      }
      log.info(TAG, `Loaded ${collDocs.length} collection documents across ${collections.size} tables`)

      // Load singletons
      const { resources: singletonDocs } = await containers.collections.items
        .query('SELECT c.id, c.data FROM c WHERE c.collection = "__singletons"')
        .fetchAll()

      for (const doc of singletonDocs) {
        singletons.set(doc.id as string, doc.data as string)
      }
      log.info(TAG, `Loaded ${singletonDocs.length} singletons`)

      // Load locks (for crash recovery — most will have expired via TTL)
      const { resources: lockDocs } = await containers.collections.items
        .query('SELECT c.id, c.data FROM c WHERE c.collection = "__locks"')
        .fetchAll()

      const now = Date.now()
      for (const doc of lockDocs) {
        try {
          const info = JSON.parse(doc.data as string) as LockInfo
          const name = (doc.id as string).replace('__lock_', '')
          if (info.expiresAt > now) {
            locks.set(name, info)
          }
        } catch {
          // skip malformed locks
        }
      }
      log.info(TAG, `Loaded ${locks.size} active locks`)

      // Load usage
      const { resources: usageDocs } = await containers.usage.items
        .query('SELECT c.sessionId, c.data FROM c')
        .fetchAll()

      for (const doc of usageDocs) {
        const sessionId = doc.sessionId as string
        let records = usageData.get(sessionId)
        if (!records) {
          records = []
          usageData.set(sessionId, records)
        }
        records.push(doc.data as string)
      }
      log.info(TAG, `Loaded ${usageDocs.length} usage records across ${usageData.size} sessions`)

      log.info(TAG, 'Cosmos backend initialization complete')
    },

    async shutdown(): Promise<void> {
      log.info(TAG, 'Shutting down Cosmos backend, draining write queue...')
      await writeQueue.drain()
      log.info(TAG, 'Write queue drained')
    },
  }

  return backend
}
