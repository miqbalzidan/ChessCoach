/**
 * The same SQLite, compiled to WebAssembly, behind the same interface.
 *
 * Every query in `core/` is written once and runs in both places — that is the whole
 * reason the phone port is a few hundred lines rather than a rewrite. What differs is
 * only the binding: better-sqlite3 on a server, this in a browser.
 *
 * Three differences between the two bindings had to be absorbed here. All three were
 * found by running core's real queries against this file, not by reading docs:
 *
 * - **Named parameters need their prefix.** core's queries say `@player` and pass
 *   `{ player: 1 }`, which better-sqlite3 accepts. sqlite-wasm throws
 *   `Invalid bind() parameter name: player`, so the keys are rewritten on the way in.
 *
 * - **Extra parameters are fatal here and harmless there.** See `bindArgs`. This is
 *   the one that would have looked like a bug in the statistics rather than in the
 *   binding.
 *
 * - **Persistence uses the SAHPool VFS, not the original OPFS one.** The original
 *   needs SharedArrayBuffer, which needs COOP/COEP response headers, which needs a
 *   server we deliberately do not have. SAHPool needs neither.
 */
import type { DB, RunResult, Statement } from '../../../core/src/db.js';

/** The slice of sqlite-wasm's oo1 API this adapter drives. */
interface Oo1Statement {
  bind(values: unknown): Oo1Statement;
  bind(name: string, value: unknown): Oo1Statement;
  /** 0 when the statement does not declare that parameter. */
  getParamIndex(name: string): number;
  step(): boolean;
  get(target: Record<string, unknown>): Record<string, unknown>;
  reset(clearBindings?: boolean): Oo1Statement;
  finalize(): void;
}

interface Oo1Db {
  prepare(sql: string): Oo1Statement;
  exec(sql: string): unknown;
  changes(): number;
  close(): void;
  pointer?: unknown;
}

export interface WasmDbDeps {
  /** `sqlite3.capi.sqlite3_last_insert_rowid`, which oo1 does not expose directly. */
  lastInsertRowid(db: Oo1Db): number;
}

/**
 * Binds either style core uses: one object of named parameters, or a list of
 * positional ones. Which it is, is decided the same way better-sqlite3 decides —
 * a lone plain object is names, anything else is positions.
 *
 * Names are bound one at a time, and only the ones the statement actually declares.
 * core builds its parameters and its WHERE clause separately on purpose — `lensParams`
 * always supplies `@eco`, while `lensClause` only mentions it when an opening is
 * picked — so an object routinely carries keys a given query has no use for.
 * better-sqlite3 ignores the extras; sqlite-wasm refuses the whole bind. Absorbing
 * that difference here is why this file exists.
 */
function bindArgs(stmt: Oo1Statement, params: unknown[]): void {
  if (params.length === 0) return;

  const first = params[0];
  const isNamed =
    params.length === 1 &&
    typeof first === 'object' &&
    first !== null &&
    !Array.isArray(first) &&
    Object.getPrototypeOf(first) === Object.prototype;

  if (!isNamed) {
    stmt.bind(params);
    return;
  }

  for (const [key, value] of Object.entries(first as Record<string, unknown>)) {
    const name = /^[@:$]/.test(key) ? key : `@${key}`;
    if (stmt.getParamIndex(name) > 0) stmt.bind(name, value);
  }
}

/**
 * Wraps one oo1 database as core's `DB`.
 *
 * Statements are prepared once and reset between uses, because the move insert runs
 * this thousands of times per game and re-preparing each row is the difference
 * between a slow import and an unusable one.
 */
export function wrapOo1Db(db: Oo1Db, deps: WasmDbDeps): DB {
  const cache = new Map<string, Oo1Statement>();

  function statementFor(sql: string): Oo1Statement {
    const existing = cache.get(sql);
    if (existing) return existing.reset(true);
    const prepared = db.prepare(sql);
    cache.set(sql, prepared);
    return prepared;
  }

  function prepare(sql: string): Statement {
    return {
      get(...params: unknown[]): unknown {
        const stmt = statementFor(sql);
        bindArgs(stmt, params);
        const row = stmt.step() ? stmt.get({}) : undefined;
        stmt.reset(true);
        return row;
      },
      all(...params: unknown[]): unknown[] {
        const stmt = statementFor(sql);
        bindArgs(stmt, params);
        const rows: unknown[] = [];
        while (stmt.step()) rows.push(stmt.get({}));
        stmt.reset(true);
        return rows;
      },
      run(...params: unknown[]): RunResult {
        const stmt = statementFor(sql);
        bindArgs(stmt, params);
        stmt.step();
        stmt.reset(true);
        return { changes: db.changes(), lastInsertRowid: deps.lastInsertRowid(db) };
      },
    };
  }

  return {
    prepare,
    exec(sql: string) {
      // A cached statement belonging to a table this DDL is about to change would be
      // stale, and SQLite would rather error than guess. Simplest correct answer is
      // to drop the cache; schema changes are rare and imports are not.
      for (const stmt of cache.values()) stmt.finalize();
      cache.clear();
      return db.exec(sql);
    },
    close() {
      for (const stmt of cache.values()) stmt.finalize();
      cache.clear();
      return db.close();
    },
    transaction<Args extends unknown[]>(fn: (...args: Args) => void) {
      return (...args: Args): void => {
        db.exec('BEGIN');
        try {
          fn(...args);
          db.exec('COMMIT');
        } catch (error) {
          db.exec('ROLLBACK');
          throw error;
        }
      };
    },
  };
}

export interface OpenedDb {
  db: DB;
  /** False when the browser would not give us OPFS and this database is in memory
   *  only — the caller has to tell the person, because their import will not last. */
  persistent: boolean;
}

/**
 * Does this browser offer the storage the persistent database needs at all?
 *
 * Probed structurally rather than through DOM types: this file is also compiled by
 * the server's test project, which has no DOM lib, and a type-only dependency there
 * would be a build error for no benefit.
 */
function opfsAvailable(): boolean {
  const scope = globalThis as Record<string, unknown>;
  const nav = scope.navigator as { storage?: { getDirectory?: unknown } } | undefined;
  const handle = scope.FileSystemFileHandle as { prototype?: object } | undefined;
  return (
    typeof nav?.storage?.getDirectory === 'function' &&
    typeof handle?.prototype === 'object' &&
    handle.prototype !== null &&
    'createSyncAccessHandle' in handle.prototype
  );
}

/**
 * Opens the phone's database, persistent if the browser allows it.
 *
 * Falling back to memory is right for a browser that has no OPFS — a sheet that works
 * for this session beats an error page, as long as it says so. It is **wrong** when
 * OPFS exists but the file is already held, which is what happens if a second Worker
 * tries to open the same database: degrading silently there would hand someone a
 * blank app and quietly throw away everything they imported into it. So the two cases
 * are told apart, and only the first one degrades.
 */
export async function openBrowserDb(filename = '/chesscoach.db'): Promise<OpenedDb> {
  const { default: sqlite3InitModule } = await import('@sqlite.org/sqlite-wasm');
  const sqlite3 = await sqlite3InitModule();
  const deps: WasmDbDeps = {
    lastInsertRowid: (db) =>
      Number((sqlite3 as any).capi.sqlite3_last_insert_rowid((db as any).pointer ?? db)),
  };

  // One attempt, deliberately. A failed `installOpfsSAHPoolVfs` runs the library's own
  // recovery, which tries to remove and recreate the pool — so retrying in a loop
  // risks clearing the very database it is trying to open. The page terminates its
  // Worker on `pagehide` instead, which releases the file before the next page asks
  // for it; a short wait here covers the rest of that handover.
  let lastError: unknown;
  try {
    const pool = await (sqlite3 as any).installOpfsSAHPoolVfs({ name: 'chesscoach' });
    return { db: wrapOo1Db(new pool.OpfsSAHPoolDb(filename) as Oo1Db, deps), persistent: true };
  } catch (error) {
    lastError = error;
  }

  if (opfsAvailable()) {
    // Still held after several seconds, so it is genuinely somewhere else. Degrading
    // to memory here would hand someone a blank app and quietly throw away everything
    // they had imported, which is worse than saying so.
    throw new Error(
      'Your games are open in another tab. Close it and reload — a second copy here ' +
        'would start from an empty database.',
      { cause: lastError },
    );
  }

  console.warn('No OPFS storage in this browser; nothing imported here will survive a reload.');
  return { db: wrapOo1Db(new (sqlite3 as any).oo1.DB(':memory:') as Oo1Db, deps), persistent: false };
}
