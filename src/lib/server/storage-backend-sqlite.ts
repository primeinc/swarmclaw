/**
 * SQLite storage backend — the default for local development.
 *
 * This is a mechanical extraction of all db.prepare/db.exec calls that
 * were previously inline in storage.ts. Behavior is identical.
 */

import path from 'path'
import Database from 'better-sqlite3'
import type { StorageBackend, LockInfo } from './storage-backend'
import { DATA_DIR, IS_BUILD_BOOTSTRAP } from './data-dir'
import {
  tryAcquireRuntimeLock as _tryAcquireLock,
  renewRuntimeLock as _renewLock,
  readRuntimeLock as _readLock,
  isRuntimeLockActive as _isLockActive,
  releaseRuntimeLock as _releaseLock,
} from './storage-locks'

import { COLLECTIONS } from './storage-collections'

export function createSQLiteBackend(): StorageBackend {
  const DB_PATH = IS_BUILD_BOOTSTRAP ? ':memory:' : path.join(DATA_DIR, 'swarmclaw.db')
  const db = new Database(DB_PATH)

  if (!IS_BUILD_BOOTSTRAP) {
    db.pragma('journal_mode = WAL')
    db.pragma('busy_timeout = 5000')
    db.pragma('synchronous = NORMAL')
    db.pragma('cache_size = -64000')
    db.pragma('mmap_size = 268435456')
  }
  db.pragma('foreign_keys = ON')

  // Create tables
  for (const table of COLLECTIONS) {
    db.exec(`CREATE TABLE IF NOT EXISTS ${table} (id TEXT PRIMARY KEY, data TEXT NOT NULL)`)
  }
  db.exec(`CREATE INDEX IF NOT EXISTS idx_protocol_run_events_runid ON protocol_run_events (json_extract(data, '$.runId'))`)
  db.exec(`CREATE TABLE IF NOT EXISTS settings (id INTEGER PRIMARY KEY CHECK (id = 1), data TEXT NOT NULL)`)
  db.exec(`CREATE TABLE IF NOT EXISTS queue (id INTEGER PRIMARY KEY CHECK (id = 1), data TEXT NOT NULL)`)
  db.exec(`CREATE TABLE IF NOT EXISTS usage (session_id TEXT NOT NULL, data TEXT NOT NULL)`)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_usage_session ON usage(session_id)`)
  db.exec(`CREATE TABLE IF NOT EXISTS runtime_locks (
    name TEXT PRIMARY KEY,
    owner TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`)

  const backend: StorageBackend = {
    // ── Collections ──────────────────────────────────────────────

    readCollectionRaw(table: string): Map<string, string> {
      const rows = db.prepare(`SELECT id, data FROM ${table}`).all() as { id: string; data: string }[]
      const result = new Map<string, string>()
      for (const row of rows) {
        result.set(row.id, row.data)
      }
      return result
    },

    readItem(table: string, id: string): string | null {
      const row = db.prepare(`SELECT data FROM ${table} WHERE id = ?`).get(id) as { data: string } | undefined
      return row?.data ?? null
    },

    upsertItem(table: string, id: string, json: string): void {
      db.prepare(`INSERT OR REPLACE INTO ${table} (id, data) VALUES (?, ?)`).run(id, json)
    },

    upsertItems(table: string, entries: Array<[string, string]>): void {
      if (!entries.length) return
      const tx = db.transaction(() => {
        const stmt = db.prepare(`INSERT OR REPLACE INTO ${table} (id, data) VALUES (?, ?)`)
        for (const [id, json] of entries) {
          stmt.run(id, json)
        }
      })
      tx()
    },

    deleteItem(table: string, id: string): void {
      db.prepare(`DELETE FROM ${table} WHERE id = ?`).run(id)
    },

    saveCollection(table: string, toUpsert: Array<[string, string]>, toDelete: string[]): void {
      const tx = db.transaction(() => {
        if (toDelete.length) {
          const del = db.prepare(`DELETE FROM ${table} WHERE id = ?`)
          for (const id of toDelete) del.run(id)
        }
        if (toUpsert.length) {
          const ins = db.prepare(`INSERT OR REPLACE INTO ${table} (id, data) VALUES (?, ?)`)
          for (const [id, json] of toUpsert) ins.run(id, json)
        }
      })
      tx()
    },

    // ── Singletons ───────────────────────────────────────────────

    readSingleton(key: string): string | null {
      const row = db.prepare(`SELECT data FROM ${key} WHERE id = 1`).get() as { data: string } | undefined
      return row?.data ?? null
    },

    writeSingleton(key: string, json: string): void {
      db.prepare(`INSERT OR REPLACE INTO ${key} (id, data) VALUES (1, ?)`).run(json)
    },

    // ── Usage ────────────────────────────────────────────────────

    appendUsage(sessionId: string, json: string): void {
      db.prepare('INSERT INTO usage (session_id, data) VALUES (?, ?)').run(sessionId, json)
    },

    readAllUsage(): Array<{ session_id: string; data: string }> {
      return db.prepare('SELECT session_id, data FROM usage').all() as Array<{ session_id: string; data: string }>
    },

    pruneOldUsage(maxAgeMs: number): number {
      const cutoff = Date.now() - maxAgeMs
      const result = db.prepare(
        `DELETE FROM usage WHERE CAST(COALESCE(json_extract(data, '$.timestamp'), 0) AS INTEGER) < ?`,
      ).run(cutoff)
      return result.changes
    },

    getUsageSpendSince(minTimestamp: number): number {
      const row = db.prepare(`
        SELECT COALESCE(SUM(CAST(json_extract(data, '$.estimatedCost') AS REAL)), 0) AS total
        FROM usage
        WHERE CAST(COALESCE(json_extract(data, '$.timestamp'), 0) AS INTEGER) >= ?
      `).get(minTimestamp) as { total?: number | null } | undefined
      const total = Number(row?.total ?? 0)
      return Number.isFinite(total) ? total : 0
    },

    // ── Locks ────────────────────────────────────────────────────

    tryAcquireLock(name: string, owner: string, ttlMs: number): boolean {
      return _tryAcquireLock(db, name, owner, ttlMs)
    },

    renewLock(name: string, owner: string, ttlMs: number): boolean {
      return _renewLock(db, name, owner, ttlMs)
    },

    readLock(name: string): LockInfo | null {
      return _readLock(db, name)
    },

    isLockActive(name: string): boolean {
      return _isLockActive(db, name)
    },

    releaseLock(name: string, owner: string): void {
      _releaseLock(db, name, owner)
    },

    pruneExpiredLocks(): number {
      const result = db.prepare('DELETE FROM runtime_locks WHERE expires_at < ?').run(Date.now())
      return result.changes
    },

    // ── Queries ──────────────────────────────────────────────────

    queryByJsonField(table: string, fieldPath: string, value: string, orderByField?: string): string[] {
      const orderClause = orderByField
        ? ` ORDER BY json_extract(data, '${orderByField}') ASC`
        : ''
      const rows = db.prepare(
        `SELECT data FROM ${table} WHERE json_extract(data, '${fieldPath}') = ?${orderClause}`,
      ).all(value) as Array<{ data: string }>
      return rows.map(r => r.data)
    },

    countItems(table: string): number {
      const row = db.prepare(`SELECT COUNT(*) as c FROM ${table}`).get() as { c: number }
      return row.c
    },

    bulkUpdate(table: string, updater: (id: string, json: string) => string | null): number {
      const rows = db.prepare(`SELECT id, data FROM ${table}`).all() as Array<{ id: string; data: string }>
      if (!rows.length) return 0

      const update = db.prepare(`UPDATE ${table} SET data = ? WHERE id = ?`)
      let changed = 0

      const tx = db.transaction(() => {
        for (const row of rows) {
          const newJson = updater(row.id, row.data)
          if (newJson !== null) {
            update.run(newJson, row.id)
            changed++
          }
        }
      })
      tx()
      return changed
    },

    // ── Transactions ─────────────────────────────────────────────

    withTransaction<T>(fn: () => T): T {
      const wrapped = db.transaction(fn)
      return wrapped()
    },

    // ── Lifecycle ────────────────────────────────────────────────

    async initialize(): Promise<void> {
      // No-op — SQLite is ready as soon as the constructor runs.
    },

    async shutdown(): Promise<void> {
      db.close()
    },
  }

  return backend
}
