/**
 * StorageBackend interface — the low-level data access layer.
 *
 * storage.ts delegates all persistence to this interface.
 * Two implementations exist:
 *   - SQLiteBackend  (local development, default)
 *   - CosmosMemoryBackend  (Azure production, STORAGE_BACKEND=cosmos)
 *
 * All methods except initialize() and shutdown() are synchronous —
 * the Cosmos backend achieves this via in-memory maps + async write-behind.
 */

export interface LockInfo {
  owner: string
  expiresAt: number
  updatedAt: number
}

export interface StorageBackend {
  // ── Collections ──────────────────────────────────────────────────
  /** Load all rows for a collection table as id → JSON string. */
  readCollectionRaw(table: string): Map<string, string>

  /** Read a single item by id. Returns raw JSON string or null. */
  readItem(table: string, id: string): string | null

  /** Upsert a single item (id → serialized JSON). */
  upsertItem(table: string, id: string, json: string): void

  /** Upsert multiple items in a batch. */
  upsertItems(table: string, entries: Array<[string, string]>): void

  /** Delete a single item by id. */
  deleteItem(table: string, id: string): void

  /** Diff-based save: upsert changed items, delete removed items. */
  saveCollection(table: string, toUpsert: Array<[string, string]>, toDelete: string[]): void

  // ── Singletons ───────────────────────────────────────────────────
  /** Read a singleton row (settings, queue). Returns raw JSON string or null. */
  readSingleton(key: string): string | null

  /** Write a singleton row. */
  writeSingleton(key: string, json: string): void

  // ── Usage (append-only per session) ──────────────────────────────
  appendUsage(sessionId: string, json: string): void
  readAllUsage(): Array<{ session_id: string; data: string }>
  pruneOldUsage(maxAgeMs: number): number
  getUsageSpendSince(minTimestamp: number): number

  // ── Locks ────────────────────────────────────────────────────────
  tryAcquireLock(name: string, owner: string, ttlMs: number): boolean
  renewLock(name: string, owner: string, ttlMs: number): boolean
  readLock(name: string): LockInfo | null
  isLockActive(name: string): boolean
  releaseLock(name: string, owner: string): void
  pruneExpiredLocks(): number

  // ── JSON field queries ───────────────────────────────────────────
  /**
   * Query items in a collection by a JSON field value.
   * fieldPath is like '$.runId', value is the exact match.
   * Returns raw JSON strings of matching documents.
   */
  queryByJsonField(table: string, fieldPath: string, value: string, orderByField?: string): string[]

  /** Count items in a collection. */
  countItems(table: string): number

  // ── Bulk operations ──────────────────────────────────────────────
  /**
   * Bulk read + update all rows in a table. Used by disableAllSessionHeartbeats.
   * The updater receives each row and returns updated JSON or null to skip.
   */
  bulkUpdate(table: string, updater: (id: string, json: string) => string | null): number

  // ── Transactions ─────────────────────────────────────────────────
  /** Wrap a synchronous function in an atomic transaction. */
  withTransaction<T>(fn: () => T): T

  // ── Lifecycle ────────────────────────────────────────────────────
  /** Async initialization (Cosmos: loads all data into memory). */
  initialize(): Promise<void>

  /** Graceful shutdown (Cosmos: drains write queue). */
  shutdown(): Promise<void>
}
