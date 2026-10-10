import { mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync, type SQLInputValue, type StatementSync } from 'node:sqlite';

export const SCHEMA_VERSION = '1';
const SCHEMA_SQL = readFileSync(fileURLToPath(new URL('./schema.sql', import.meta.url)), 'utf8');

type Param = SQLInputValue | boolean | undefined;
export type Row = Record<string, unknown>;

export class TxError extends Error {}

/**
 * Thin wrapper over node:sqlite. Every statement is cached; `tx()` is the only way to open a
 * transaction. Transactions are synchronous (no `await` can sneak in) and never nest, so in a
 * single process every command is serialized.
 */
export class Sql {
  private readonly cache = new Map<string, StatementSync>();
  private depth = 0;

  constructor(readonly db: DatabaseSync) {}

  private stmt(sql: string): StatementSync {
    let s = this.cache.get(sql);
    if (!s) {
      s = this.db.prepare(sql);
      this.cache.set(sql, s);
    }
    return s;
  }

  get<T = Row>(sql: string, ...params: Param[]): T | undefined {
    return this.stmt(sql).get(...params.map(norm)) as T | undefined;
  }

  all<T = Row>(sql: string, ...params: Param[]): T[] {
    return this.stmt(sql).all(...params.map(norm)) as T[];
  }

  run(sql: string, ...params: Param[]): { changes: number; lastId: number } {
    const r = this.stmt(sql).run(...params.map(norm));
    return { changes: Number(r.changes), lastId: Number(r.lastInsertRowid) };
  }

  exec(sql: string): void {
    this.db.exec(sql);
  }

  get inTransaction(): boolean {
    return this.depth > 0;
  }

  tx<T>(fn: () => T): T {
    if (this.depth > 0) throw new TxError('Nested transaction: commands must not call other public commands');
    this.db.exec('BEGIN IMMEDIATE');
    this.depth = 1;
    try {
      const out = fn();
      if (out && typeof (out as { then?: unknown }).then === 'function') {
        throw new TxError('Transaction callback returned a promise; transactions must be synchronous');
      }
      this.db.exec('COMMIT');
      return out;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    } finally {
      this.depth = 0;
    }
  }

  /** Forget prepared statements (after the schema is dropped and recreated). */
  clearCache(): void {
    this.cache.clear();
  }

  close(): void {
    this.cache.clear();
    this.db.close();
  }
}

function norm(p: Param): SQLInputValue {
  if (p === undefined) return null;
  if (typeof p === 'boolean') return p ? 1 : 0;
  return p;
}

export function openDb(path: string): Sql {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  if (path !== ':memory:') db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;');
  db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  const sql = new Sql(db);
  migrate(sql);
  return sql;
}

export function migrate(sql: Sql): void {
  sql.exec(SCHEMA_SQL);
  const v = sql.get<{ value: string }>(`SELECT value FROM meta WHERE key = 'schema_version'`);
  if (!v) {
    sql.run(`INSERT INTO meta (key, value) VALUES ('schema_version', ?)`, SCHEMA_VERSION);
    // Task ids start at 101 so seeded and new tasks read as T-101, T-102, …
    sql.run(`INSERT INTO sqlite_sequence (name, seq) SELECT 'tasks', 100 WHERE NOT EXISTS (SELECT 1 FROM sqlite_sequence WHERE name = 'tasks')`);
  } else if (v.value !== SCHEMA_VERSION) {
    throw new Error(`Database schema is v${v.value}, code expects v${SCHEMA_VERSION}. Run \`npm run reset\`.`);
  }
}

/**
 * 'empty': a new database. 'seeded': the seed finished (or the desk has booted on it before).
 * 'partial': contributors exist but the seed never finished, because a first start or a reset was killed
 * mid-seed (the seed is many transactions). It must be reset, not used.
 */
export function seedState(sql: Sql): 'empty' | 'partial' | 'seeded' {
  if (sql.get(`SELECT 1 AS x FROM meta WHERE key IN ('seeded_at', 'boot_count') LIMIT 1`)) return 'seeded';
  return sql.get(`SELECT 1 AS x FROM contributors LIMIT 1`) ? 'partial' : 'empty';
}

/**
 * Drop everything and recreate, in ONE transaction (SQLite DDL is transactional): a kill part-way
 * leaves the old database intact, never half of one. Foreign keys are circular (tasks ↔ routing_attempts),
 * so they are switched off first; that pragma is a no-op inside a transaction.
 */
export function resetDb(sql: Sql): void {
  if (sql.inTransaction) throw new TxError('resetDb inside a transaction');
  sql.clearCache();
  sql.exec('PRAGMA foreign_keys = OFF');
  try {
    sql.tx(() => {
      const objects = sql.all<{ type: string; name: string }>(`SELECT type, name FROM sqlite_master WHERE type IN ('table','trigger') AND name NOT LIKE 'sqlite_%'`);
      for (const o of objects.filter((x) => x.type === 'trigger')) sql.exec(`DROP TRIGGER IF EXISTS "${o.name}"`);
      for (const o of objects.filter((x) => x.type === 'table')) sql.exec(`DROP TABLE IF EXISTS "${o.name}"`);
      sql.exec(`DELETE FROM sqlite_sequence`);
      migrate(sql);
    });
  } finally {
    sql.clearCache();
    sql.exec('PRAGMA foreign_keys = ON');
  }
}
