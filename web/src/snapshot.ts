/**
 * Reading a leak sheet with no server behind it.
 *
 * A snapshot arrives one of two ways: baked into a single exported HTML file, or
 * opened from a `.leaksheet.json.gz` and kept in IndexedDB. Either way the screens
 * are unchanged — `request()` in api.ts answers from here instead of the network,
 * because everything they ask for was computed on the machine that has the engine.
 */
import type {
  Coaching,
  Dashboard,
  Game,
  GameResult,
  Lens,
  Move,
  OpeningRow,
  Pattern,
  Scope,
  Snapshot,
  SnapshotScope,
  TimeClass,
} from './types';
import { lensKey, SNAPSHOT_VERSION } from './types';

declare global {
  interface Window {
    /** Set by the boot script the exporter inlines. Resolves to the snapshot. */
    __LEAKSHEET_BOOT__?: Promise<Snapshot>;
  }
}

const DB_NAME = 'leaksheet';
const STORE = 'snapshots';
const KEY = 'active';

let active: Snapshot | null = null;

export function activeSnapshot(): Snapshot | null {
  return active;
}

export function inSnapshotMode(): boolean {
  return active !== null;
}

/**
 * Resolves the snapshot to run against, or null for the normal server-backed app.
 * An inlined snapshot wins: if you opened the exported file, that is the sheet you
 * meant to look at, whatever is also stored.
 */
export async function loadSnapshot(): Promise<Snapshot | null> {
  if (window.__LEAKSHEET_BOOT__) {
    try {
      active = validate(await window.__LEAKSHEET_BOOT__);
      return active;
    } catch (error) {
      console.error('Inlined snapshot could not be read', error);
    }
  }

  try {
    const stored = await idbGet();
    if (stored) {
      active = validate(stored);
      return active;
    }
  } catch (error) {
    console.error('Stored snapshot could not be read', error);
  }

  return null;
}

/** Reads a `.leaksheet.json.gz` (or plain `.json`) the person picked, and keeps it. */
export async function importSnapshotFile(file: File): Promise<Snapshot> {
  const buffer = await file.arrayBuffer();
  const looksGzipped = new Uint8Array(buffer.slice(0, 2)).join(',') === '31,139';

  let text: string;
  if (looksGzipped) {
    if (typeof DecompressionStream !== 'function') {
      throw new Error('This browser cannot open a compressed snapshot.');
    }
    const stream = new Blob([buffer]).stream().pipeThrough(new DecompressionStream('gzip'));
    text = await new Response(stream).text();
  } else {
    text = new TextDecoder().decode(buffer);
  }

  const snapshot = validate(JSON.parse(text) as Snapshot);
  await idbPut(snapshot);
  active = snapshot;
  return snapshot;
}

export async function clearStoredSnapshot(): Promise<void> {
  await idbDelete();
  active = null;
}

function validate(snapshot: Snapshot): Snapshot {
  if (!snapshot || typeof snapshot !== 'object') throw new Error('Not a snapshot.');
  if (!snapshot.player) throw new Error('Snapshot is missing its contents.');
  if (snapshot.version > SNAPSHOT_VERSION) {
    throw new Error(
      `This snapshot was written by a newer version (${snapshot.version}). Update the app.`,
    );
  }

  // Version 1 knew only about time classes. Reading its five scopes as five
  // unfiltered lenses costs nothing and keeps already-exported files readable; the
  // opening filter then simply has nothing to offer, which is the truth about them.
  if (!snapshot.lenses && snapshot.scopes) {
    snapshot.lenses = { ...snapshot.scopes } as Record<string, SnapshotScope>;
  }
  if (!snapshot.lenses) throw new Error('Snapshot is missing its contents.');
  return snapshot;
}

/* ---------- serving the read endpoints ---------- */

export class SnapshotError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'SnapshotError';
  }
}

/**
 * Answers the same shapes the HTTP API answers, from precomputed data.
 * Anything that would change the data is refused — a snapshot is a photograph.
 */
export function serveFromSnapshot<T>(path: string, init?: RequestInit): T {
  const snapshot = active;
  if (!snapshot) throw new SnapshotError('No snapshot loaded.', 500);

  const method = (init?.method ?? 'GET').toUpperCase();
  if (method !== 'GET') {
    throw new SnapshotError('This is a snapshot — analysis happens on the computer.', 405);
  }

  // A base is required to parse a relative path; it is never used for anything.
  const url = new URL(path, 'http://snapshot.local');
  const segments = url.pathname.split('/').filter(Boolean);
  const lens = parseLens(url);
  const scope = lens.scope;

  if (segments[0] === 'health') {
    return {
      ok: true,
      engine: snapshot.engine,
      engines: 0,
      coaching: 'snapshot',
      defaultDepth: snapshot.analysisDepth,
    } as T;
  }

  if (segments[0] === 'settings') {
    return {
      analysisDepth: snapshot.analysisDepth,
      engine: snapshot.engine,
      engines: 0,
      coaching: 'snapshot',
      players: [snapshot.player],
    } as T;
  }

  if (segments[0] === 'players' && segments.length === 1) {
    return { players: [snapshot.player] } as T;
  }

  if (segments[0] === 'games' && segments[1]) {
    const id = Number(segments[1]);
    const game = snapshot.games.find((candidate) => candidate.id === id);
    if (!game) throw new SnapshotError('No such game', 404);
    return { game, moves: snapshot.moves[String(id)] ?? [] } as T;
  }

  if (segments[0] === 'players' && segments[1]) {
    const tail = segments[2];

    // The snapshot holds one player, so the name in the path is only ever a check.
    if (decodeURIComponent(segments[1]).toLowerCase() !== snapshot.player.username.toLowerCase()) {
      throw new SnapshotError('This snapshot is for a different player', 404);
    }

    if (tail === 'job') return { job: null } as T;

    if (tail === 'dashboard') {
      const stored = view(snapshot, lens).dashboard;
      return { ...stored, openings: servableOpenings(snapshot, scope) } as T;
    }

    if (tail === 'openings') {
      return { scope, openings: servableOpenings(snapshot, scope) } as T;
    }

    if (tail === 'profile') {
      // Older snapshots predate the scouting report; an empty one reads as "nothing
      // to say yet" rather than breaking the screen.
      const stored = view(snapshot, lens).profile;
      return {
        scope,
        lens,
        profile: stored ?? { strengths: [], weaknesses: [], games: 0, thin: true },
      } as T;
    }

    if (tail === 'patterns') {
      const min = Number(url.searchParams.get('min') ?? snapshot.minOccurrences);
      const { patterns, labels } = view(snapshot, lens);
      // Patterns were cut off at minOccurrences when exported, so a higher bar can be
      // applied here but a lower one cannot bring back what was never written.
      return { scope, lens, patterns: patterns.filter((p) => p.occurrences >= min), labels } as T;
    }

    if (tail === 'coaching') {
      const coaching = view(snapshot, lens).coaching;
      if (!coaching) throw new SnapshotError('No coaching in this snapshot', 404);
      return { scope, lens, coaching, cached: true } as T;
    }

    if (tail === 'games') return listGames(snapshot, url) as T;
  }

  throw new SnapshotError(`Not available in a snapshot: ${url.pathname}`, 404);
}

/**
 * The openings this file can actually be looked through.
 *
 * The menu the exporter stored is every opening the player has a sample of; the
 * lenses it wrote are the ones it could compute. Those sets match for a snapshot
 * written by this version, and do not for one written before the filter existed —
 * so the menu is intersected with what is here. A picker that offers a lens the
 * file cannot serve leads somewhere with no way back, which is worse than a picker
 * with fewer entries.
 */
function servableOpenings(snapshot: Snapshot, scope: Scope): OpeningRow[] {
  const menu = snapshot.lenses[scope]?.dashboard.openings ?? [];
  return menu.filter((row) =>
    Boolean(
      snapshot.lenses[lensKey({ scope, eco: row.eco, color: row.color as 'white' | 'black' })],
    ),
  );
}

/**
 * The sheet under one lens, or a clear refusal.
 *
 * A snapshot holds exactly the lenses the exporting machine could reach. Asking for
 * one it never wrote is not a blank screen — it is a file that cannot answer the
 * question, and saying so is the only honest response.
 */
function view(snapshot: Snapshot, lens: Lens): SnapshotScope {
  const stored = snapshot.lenses[lensKey(lens)];
  if (!stored) {
    throw new SnapshotError('This snapshot has no numbers for that opening.', 404);
  }
  return stored;
}

/** Mirrors listGames() in server/src/store.ts, including its end_time DESC ordering. */
function listGames(snapshot: Snapshot, url: URL): { games: Game[]; total: number } {
  const timeClass = url.searchParams.get('timeClass');
  const eco = url.searchParams.get('eco');
  const color = url.searchParams.get('color');
  const result = url.searchParams.get('result');
  const opponent = url.searchParams.get('opponent')?.toLowerCase();
  const analysedOnly = url.searchParams.get('analysedOnly') === 'true';
  const from = numberParam(url, 'from');
  const to = numberParam(url, 'to');
  const limit = Math.min(numberParam(url, 'limit') ?? 50, 200);
  const offset = numberParam(url, 'offset') ?? 0;

  const matched = snapshot.games.filter((game) => {
    if (timeClass && timeClass !== 'all' && game.time_class !== (timeClass as TimeClass)) {
      return false;
    }
    if (result && result !== 'all' && game.result !== (result as GameResult)) return false;
    if (eco && game.eco !== eco) return false;
    if (eco && color && game.player_color !== color) return false;
    if (opponent && !game.opponent.toLowerCase().includes(opponent)) return false;
    if (from && game.end_time < from) return false;
    if (to && game.end_time > to) return false;
    if (analysedOnly && game.analysed_at === null) return false;
    return true;
  });

  return { games: matched.slice(offset, offset + limit), total: matched.length };
}

function numberParam(url: URL, key: string): number | undefined {
  const raw = url.searchParams.get(key);
  if (raw === null || raw === '') return undefined;
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
}

function parseLens(url: URL): Lens {
  const scopes: Scope[] = ['all', 'bullet', 'blitz', 'rapid', 'daily'];
  const raw = url.searchParams.get('scope');
  const lens: Lens = { scope: scopes.includes(raw as Scope) ? (raw as Scope) : 'all' };

  const eco = url.searchParams.get('eco');
  if (eco && /^[A-E][0-9]{2}$/.test(eco)) {
    lens.eco = eco;
    const color = url.searchParams.get('color');
    if (color === 'white' || color === 'black') lens.color = color;
  }
  return lens;
}

/* ---------- IndexedDB ----------
   A snapshot is a couple of megabytes of JSON, which is past what localStorage is
   willing to hold, so it lives in IndexedDB. */

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE)) {
        request.result.createObjectStore(STORE);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function idbGet(): Promise<Snapshot | null> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const request = db.transaction(STORE, 'readonly').objectStore(STORE).get(KEY);
    request.onsuccess = () => resolve((request.result as Snapshot | undefined) ?? null);
    request.onerror = () => reject(request.error);
  });
}

async function idbPut(snapshot: Snapshot): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE, 'readwrite');
    transaction.objectStore(STORE).put(snapshot, KEY);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  });
}

async function idbDelete(): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE, 'readwrite');
    transaction.objectStore(STORE).delete(KEY);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  });
}

export type { Coaching, Dashboard, Move, Pattern };
