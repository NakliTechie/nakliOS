/**
 * Dish's `node:sqlite`: the `DatabaseSync` / `StatementSync` subset dsh's session search uses, on SQLite's own
 * WebAssembly build (@sqlite.org/sqlite-wasm, FTS5 included). prepare.py puts this file in place of upstream's
 * stub. The Worker loads SQLite in the background after boot (worker-bridge.txt), because upstream opens the database
 * synchronously right after `await import('node:sqlite')`. In-memory databases only: the search index is derived
 * from the session logs and rebuilt each boot.
 */
import { notAvailableError } from '../../notImplementedFail.ts'

const MODULE = 'node:sqlite'
type Sqlite3 = {
  oo1: { DB: new (path: string) => OoDb }
}
type OoStmt = {
  bind(values: unknown[]): void
  step(): boolean
  get(row: Record<string, unknown>): Record<string, unknown>
  reset(clearBindings?: boolean): void
  finalize(): void
}
type OoDb = {
  exec(sql: string): void
  prepare(sql: string): OoStmt
  changes(): number
  selectValue(sql: string): unknown
  close(): void
}
const dish = globalThis as typeof globalThis & { __dishSqlite3?: Sqlite3, __dishSqlite3Error?: string }

function engine(): Sqlite3 {
  if (dish.__dishSqlite3) return dish.__dishSqlite3
  throw new Error(dish.__dishSqlite3Error
    ? `SQLite could not load in Dish: ${dish.__dishSqlite3Error}`
    : 'SQLite is still loading in Dish; try the search again in a few seconds')
}

/** node:sqlite statement: each call binds positional values afresh and resets afterwards. */
export class StatementSync {
  #stmt: OoStmt
  #db: OoDb
  constructor(db: OoDb, sql: string) { this.#db = db; this.#stmt = db.prepare(sql) }
  #start(values: unknown[]): void {
    this.#stmt.reset(true)
    if (values.length) this.#stmt.bind(values.map(value => typeof value === 'boolean' ? Number(value) : value))
  }
  all(...values: unknown[]): Record<string, unknown>[] {
    this.#start(values)
    const rows: Record<string, unknown>[] = []
    try { while (this.#stmt.step()) rows.push(this.#stmt.get({})) } finally { this.#stmt.reset(true) }
    return rows
  }
  get(...values: unknown[]): Record<string, unknown> | undefined {
    this.#start(values)
    try { return this.#stmt.step() ? this.#stmt.get({}) : undefined } finally { this.#stmt.reset(true) }
  }
  run(...values: unknown[]): { changes: number, lastInsertRowid: number } {
    this.#start(values)
    try { while (this.#stmt.step()) { /* drain */ } } finally { this.#stmt.reset(true) }
    return { changes: this.#db.changes(), lastInsertRowid: Number(this.#db.selectValue('SELECT last_insert_rowid()')) }
  }
  finalize(): void { this.#stmt.finalize() }
}

/** node:sqlite database, in memory. */
export class DatabaseSync {
  #db: OoDb | undefined
  #statements: StatementSync[] = []
  constructor(path: string) {
    if (path !== ':memory:') throw notAvailableError(MODULE, `DatabaseSync for ${path} (Dish keeps SQLite databases in memory)`)
    this.#db = new (engine().oo1.DB)(':memory:')
  }
  #open(): OoDb {
    if (!this.#db) throw new Error('database is not open')
    return this.#db
  }
  get isOpen(): boolean { return this.#db !== undefined }
  exec(sql: string): void { this.#open().exec(sql) }
  prepare(sql: string): StatementSync {
    const statement = new StatementSync(this.#open(), sql)
    this.#statements.push(statement)
    return statement
  }
  close(): void {
    if (!this.#db) return
    for (const statement of this.#statements) { try { statement.finalize() } catch { /* already gone */ } }
    this.#statements = []
    this.#db.close()
    this.#db = undefined
  }
}

/**
 * Backup helper (unavailable).
 * @returns Never — it throws naming the unavailable member.
 */
export function backup(): never {
  throw notAvailableError(MODULE, 'backup')
}

/** CommonJS interop marker: the worker loader hands `default` to default imports (see ./builtins.ts). */
export const __esModule = true

/** CommonJS default export: the members `require()` hands a caller of this module. */
export default {
  DatabaseSync: DatabaseSync as unknown as typeof import('node:sqlite').DatabaseSync,
  StatementSync: StatementSync as unknown as typeof import('node:sqlite').StatementSync,
  backup,
} satisfies Partial<typeof import('node:sqlite')>
