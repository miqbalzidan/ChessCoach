/**
 * The server, running inside the phone.
 *
 * This Worker holds everything the Node process used to hold: the database, the
 * engine pool, and the routes over them. It exists as a Worker for two reasons, and
 * the first is not negotiable — OPFS's synchronous file handles are only available
 * off the main thread, so the database has to live here. The second is that analysis
 * pins a core for minutes at a time, and doing that on the UI thread would freeze
 * the sheet you are reading.
 *
 * Inside, everything is the ordinary synchronous code from `core/`. Only the message
 * boundary is async, which is why none of the statistics had to be rewritten.
 *
 * The route table mirrors `server/src/api.ts` deliberately. That file is the
 * specification; where the two disagree, that one is right.
 */
import { analyseGame } from '../../../core/src/analysis.js';
import { configureChessCom } from '../../../core/src/chesscom.js';
import { getSetting, migrate, setSetting, type DB } from '../../../core/src/db.js';
import { parseEco, parseLens, parseScope } from '../../../core/src/lens.js';
import { MOTIF_LABELS } from '../../../core/src/motifs.js';
import { detectPatterns } from '../../../core/src/patterns.js';
import { profile } from '../../../core/src/profile.js';
import { dashboard, openings } from '../../../core/src/stats.js';
import {
  deletePlayerData,
  findPlayer,
  getGame,
  getMoves,
  listGames,
  listPlayers,
  saveAnalysis,
  upsertPlayer,
} from '../../../core/src/store.js';
import {
  analysePending,
  createJob,
  getJob,
  latestJob,
  runImport,
  runPgnImport,
} from '../../../core/src/importer.js';
import { offlineCoaching, readCachedCoaching, writeCachedCoaching } from '../../../core/src/coach.js';
import type { EnginePool } from '../../../core/src/engine.js';
import { openBrowserDb } from './db-wasm.js';
import { createWasmEnginePool, estimateImportSeconds, measureMsPerPosition } from './engine-wasm.js';
import type { GameResult, TimeClass } from '../../../core/src/types.js';
import { TIME_CLASSES } from '../../../core/src/types.js';

/**
 * Shallower than the desktop's 16. A phone is slower and on a battery, and at depth
 * 12 the engine still agrees with the desktop about every blunder — the labels this
 * app is built on — while costing a third of the time.
 */
const PHONE_DEPTH = 12;

export interface WorkerRequest {
  id: number;
  path: string;
  method: string;
  body?: unknown;
}

export interface WorkerResponse {
  id: number;
  ok: boolean;
  data?: unknown;
  error?: string;
  status?: number;
}

class RouteError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

let persistent = false;
/** Milliseconds per position on this device, once anything has been analysed. */
let measuredMs: number | null = null;

/**
 * Both of these memoise the **promise**, not the resolved value, and that is the
 * whole point.
 *
 * The app fires several requests the moment it loads — health, players, the
 * dashboard, the patterns. Guarding with a resolved value lets all of them past the
 * check while the first is still awaiting, so each opens its own database. OPFS
 * allows exactly one holder per file, the losers trigger the VFS library's recovery,
 * and that recovery clears the pool: every game the person had imported, gone on the
 * next launch. It cost an afternoon to find, because sequential requests never
 * reproduce it.
 */
let opening: Promise<DB> | null = null;
let starting: Promise<EnginePool> | null = null;

function database(): Promise<DB> {
  opening ??= openBrowserDb().then((opened) => {
    persistent = opened.persistent;
    migrate(opened.db);
    return opened.db;
  });
  return opening;
}

/**
 * Started only when something actually needs analysing. Reading a sheet is the
 * common case and it does not need an engine — spinning two up on every launch would
 * cost a second and a couple of megabytes for nothing.
 */
function engines(): Promise<EnginePool> {
  starting ??= createWasmEnginePool().then((created) => {
    startedPool = created;
    return created;
  });
  return starting;
}

/** Only for reporting: the routes that describe the engine must not start one. */
let startedPool: EnginePool | null = null;

function depthSetting(handle: DB): number {
  return Number(getSetting(handle, 'analysisDepth', String(PHONE_DEPTH)));
}

/* ---------- routes ---------- */

async function route(request: WorkerRequest): Promise<unknown> {
  const handle = await database();
  const url = new URL(request.path, 'http://local.chesscoach');
  const segments = url.pathname.split('/').filter(Boolean);
  const method = request.method.toUpperCase();
  const body = (request.body ?? {}) as Record<string, unknown>;

  const head = segments[0];
  const name = segments[1] ? decodeURIComponent(segments[1]) : undefined;
  const tail = segments[2];

  if (head === 'health') {
    return {
      ok: true,
      engine: startedPool?.engineName ?? 'Stockfish (WebAssembly)',
      engines: startedPool?.size ?? 0,
      coaching: 'offline',
      defaultDepth: depthSetting(handle),
    };
  }

  if (head === 'settings') {
    if (method === 'POST') {
      const depth = optionalNumber(body.analysisDepth);
      if (depth !== undefined) {
        if (depth < 8 || depth > 24) throw new RouteError('Analysis depth must be between 8 and 24', 400);
        setSetting(handle, 'analysisDepth', String(Math.round(depth)));
      }
      return { analysisDepth: depthSetting(handle) };
    }
    return {
      analysisDepth: depthSetting(handle),
      engine: startedPool?.engineName ?? 'Stockfish (WebAssembly)',
      engines: startedPool?.size ?? 0,
      coaching: 'offline',
      players: listPlayers(handle),
      // Not in the server's answer, because a server's disk does not evaporate.
      persistent,
    };
  }

  if (head === 'players' && segments.length === 1) {
    if (method === 'POST') {
      const username = String(body.username ?? '').trim();
      if (!username) throw new RouteError('A username is required', 400);
      return { player: upsertPlayer(handle, username) };
    }
    return { players: listPlayers(handle) };
  }

  if (head === 'jobs' && name) {
    const job = getJob(handle, Number(name));
    if (!job) throw new RouteError('No such import job', 404);
    return { job };
  }

  if (head === 'games' && name) {
    const game = getGame(handle, Number(name));
    if (!game) throw new RouteError('No such game', 404);

    if (tail === 'analyse' && method === 'POST') {
      const depth = optionalNumber(body.depth) ?? depthSetting(handle);
      const analysis = await analyseGame(await engines(), game.pgn, { depth });
      saveAnalysis(handle, game, analysis);
      const refreshed = getGame(handle, game.id)!;
      return { game: refreshed, moves: getMoves(handle, game.id) };
    }

    return { game, moves: getMoves(handle, game.id) };
  }

  if (head === 'import') {
    const username = String(body.username ?? '').trim();
    if (!username) throw new RouteError('A username is required', 400);
    const depth = optionalNumber(body.depth) ?? depthSetting(handle);

    if (name === 'pgn') {
      const pgn = String(body.pgn ?? '');
      if (!pgn.trim()) throw new RouteError('Paste at least one game', 400);
      const job = createJob(handle, username);
      void runPgnImport(handle, await engines(), job.id, username, pgn, depth);
      return { jobId: job.id };
    }

    if (name === 'chesscom') {
      const job = createJob(handle, username);
      void runImport(handle, await engines(), job.id, {
        username,
        since: optionalNumber(body.since),
        until: optionalNumber(body.until),
        limit: optionalNumber(body.limit) ?? 50,
        timeClasses: parseTimeClasses(body.timeClasses),
        depth,
      });
      return { jobId: job.id };
    }
  }

  if (head === 'players' && name) {
    const player = findPlayer(handle, name);

    if (tail === 'job') {
      return { job: latestJob(handle, name) ?? null };
    }

    if (!player) throw new RouteError('No such player', 404);

    if (tail === 'games' && method === 'DELETE') {
      deletePlayerData(handle, player.id);
      return { ok: true };
    }

    if (tail === 'games') {
      const { games, total } = listGames(handle, player.id, {
        timeClass: parseScope(url.searchParams.get('timeClass')),
        result: parseResult(url.searchParams.get('result')),
        eco: parseEco(url.searchParams.get('eco')),
        color: parseColor(url.searchParams.get('color')),
        opponent: url.searchParams.get('opponent') || undefined,
        from: optionalNumber(url.searchParams.get('from')),
        to: optionalNumber(url.searchParams.get('to')),
        analysedOnly: url.searchParams.get('analysedOnly') === 'true',
        limit: Math.min(optionalNumber(url.searchParams.get('limit')) ?? 50, 200),
        offset: optionalNumber(url.searchParams.get('offset')) ?? 0,
      });
      return { games: games.map(stripPgn), total };
    }

    if (tail === 'resync' && method === 'POST') {
      const job = createJob(handle, player.username);
      void runImport(handle, await engines(), job.id, {
        username: player.username,
        since: newestGameTime(handle, player.id),
        limit: optionalNumber(body.limit) ?? 100,
        depth: depthSetting(handle),
      });
      return { jobId: job.id };
    }

    if (tail === 'analyse-pending' && method === 'POST') {
      const job = createJob(handle, player.username);
      void analysePending(handle, await engines(), job.id, player.id, depthSetting(handle)).then(
        () => {
          handle
            .prepare("UPDATE import_jobs SET status = 'done', stage = 'done' WHERE id = ?")
            .run(job.id);
        },
      );
      return { jobId: job.id };
    }

    const lens = parseLens(Object.fromEntries(url.searchParams));

    if (tail === 'dashboard') return { player, ...dashboard(handle, player.id, lens) };

    if (tail === 'profile') {
      return { scope: lens.scope, lens, profile: profile(handle, player.id, lens) };
    }

    if (tail === 'openings') {
      const scope = parseScope(url.searchParams.get('scope')) ?? 'all';
      return { scope, openings: openings(handle, player.id, { scope }) };
    }

    if (tail === 'patterns') {
      const minOccurrences = optionalNumber(url.searchParams.get('min')) ?? 3;
      return {
        scope: lens.scope,
        lens,
        patterns: detectPatterns(handle, player.id, lens, { minOccurrences }),
        labels: MOTIF_LABELS,
      };
    }

    if (tail === 'coaching') {
      const cached = readCachedCoaching(handle, player.id, lens);
      if (cached && url.searchParams.get('refresh') !== 'true') {
        return { scope: lens.scope, lens, coaching: cached, cached: true };
      }
      const stats = dashboard(handle, player.id, lens);
      const patterns = detectPatterns(handle, player.id, lens);
      const coaching = offlineCoaching({ username: player.username, lens, stats, patterns });
      writeCachedCoaching(handle, player.id, lens, coaching);
      return { scope: lens.scope, lens, coaching, cached: false };
    }
  }

  /* ---------- routes the server has no need for ---------- */

  if (head === 'local') {
    if (name === 'estimate') {
      // What the import warning quotes. Measured on this device the first time it is
      // asked, then remembered — the probe costs a second and the answer does not
      // change between imports.
      const games = optionalNumber(url.searchParams.get('games')) ?? 0;
      const engine = await engines();
      if (measuredMs === null) measuredMs = await measureMsPerPosition(engine, depthSetting(handle));
      return {
        msPerPosition: measuredMs,
        poolSize: engine.size,
        seconds: estimateImportSeconds(games, measuredMs, engine.size),
      };
    }
  }

  throw new RouteError(`Not available on this device: ${url.pathname}`, 404);
}

/* ---------- plumbing ---------- */

function stripPgn<T extends { pgn: string }>(game: T): Omit<T, 'pgn'> {
  const { pgn: _pgn, ...rest } = game;
  return rest;
}

function newestGameTime(handle: DB, playerId: number): number | undefined {
  const row = handle
    .prepare('SELECT MAX(end_time) AS t FROM games WHERE player_id = ?')
    .get(playerId) as { t: number | null };
  return row.t ?? undefined;
}

function optionalNumber(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parseResult(value: unknown): GameResult | 'all' | undefined {
  const lower = String(value ?? '').toLowerCase();
  if (lower === 'all') return 'all';
  return ['win', 'loss', 'draw'].includes(lower) ? (lower as GameResult) : undefined;
}

function parseColor(value: unknown): 'white' | 'black' | undefined {
  const lower = String(value ?? '').toLowerCase();
  return lower === 'white' || lower === 'black' ? lower : undefined;
}

function parseTimeClasses(value: unknown): TimeClass[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const classes = value
    .map((v) => String(v).toLowerCase())
    .filter((v): v is TimeClass => (TIME_CLASSES as string[]).includes(v));
  return classes.length > 0 ? classes : undefined;
}

// A browser is forbidden from setting User-Agent, so saying so is more honest than
// sending a header that will be silently dropped.
configureChessCom({ userAgent: '' });

self.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  const request = event.data;
  try {
    const data = await route(request);
    const response: WorkerResponse = { id: request.id, ok: true, data };
    self.postMessage(response);
  } catch (error) {
    const response: WorkerResponse = {
      id: request.id,
      ok: false,
      error: error instanceof Error ? error.message : 'Something went wrong on this device',
      status: error instanceof RouteError ? error.status : 500,
    };
    self.postMessage(response);
  }
};
