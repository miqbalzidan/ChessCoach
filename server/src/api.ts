import { Router, type Request, type Response } from 'express';
import type { DB } from './db.js';
import { getSetting, setSetting } from './db.js';
import type { EnginePool } from './engine.js';
import { analyseGame } from './analysis.js';
import {
  createJob,
  getJob,
  latestJob,
  runImport,
  runPgnImport,
  analysePending,
} from './importer.js';
import {
  deletePlayerData,
  findPlayer,
  getGame,
  getMoves,
  listGames,
  listPlayers,
  saveAnalysis,
  upsertPlayer,
} from './store.js';
import { dashboard, type Scope } from './stats.js';
import { detectPatterns } from './patterns.js';
import { generateCoaching, hasApiKey, readCachedCoaching, writeCachedCoaching } from './coach.js';
import { MOTIF_LABELS } from './motifs.js';
import { TIME_CLASSES, type GameResult, type TimeClass } from './types.js';

export function createApi(db: DB, pool: EnginePool): Router {
  const router = Router();

  router.get('/health', (_req, res) => {
    res.json({
      ok: true,
      engine: pool.engineName,
      engines: pool.size,
      coaching: hasApiKey() ? 'claude' : 'offline',
      defaultDepth: analysisDepth(db),
    });
  });

  router.get('/players', (_req, res) => {
    res.json({ players: listPlayers(db) });
  });

  router.post('/import/chesscom', (req, res) => {
    const username = String(req.body?.username ?? '').trim();
    if (!username) return res.status(400).json({ error: 'A Chess.com username is required' });

    const job = createJob(db, username);
    void runImport(db, pool, job.id, {
      username,
      since: optionalNumber(req.body?.since),
      until: optionalNumber(req.body?.until),
      limit: optionalNumber(req.body?.limit) ?? 50,
      timeClasses: parseTimeClasses(req.body?.timeClasses),
      depth: optionalNumber(req.body?.depth) ?? analysisDepth(db),
    });
    res.status(202).json({ jobId: job.id });
  });

  router.post('/import/pgn', (req, res) => {
    const username = String(req.body?.username ?? '').trim();
    const pgn = String(req.body?.pgn ?? '');
    if (!username) return res.status(400).json({ error: 'A username is required' });
    if (!pgn.trim()) return res.status(400).json({ error: 'Paste at least one PGN' });

    const job = createJob(db, username);
    void runPgnImport(
      db,
      pool,
      job.id,
      username,
      pgn,
      optionalNumber(req.body?.depth) ?? analysisDepth(db),
    );
    res.status(202).json({ jobId: job.id });
  });

  router.get('/jobs/:id', (req, res) => {
    const job = getJob(db, Number(req.params.id));
    if (!job) return res.status(404).json({ error: 'No such import job' });
    res.json({ job });
  });

  router.get('/players/:username/job', (req, res) => {
    const job = latestJob(db, req.params.username);
    res.json({ job: job ?? null });
  });

  router.post('/players/:username/resync', (req, res) => {
    const username = req.params.username;
    const player = findPlayer(db, username);
    if (!player) return res.status(404).json({ error: 'Import that player first' });

    const job = createJob(db, username);
    void runImport(db, pool, job.id, {
      username,
      // Only reach back as far as the newest game already stored.
      since: newestGameTime(db, player.id),
      limit: optionalNumber(req.body?.limit) ?? 100,
      depth: optionalNumber(req.body?.depth) ?? analysisDepth(db),
    });
    res.status(202).json({ jobId: job.id });
  });

  router.post('/players/:username/analyse-pending', (req, res) => {
    const player = findPlayer(db, req.params.username);
    if (!player) return res.status(404).json({ error: 'No such player' });

    const job = createJob(db, player.username);
    void analysePending(db, pool, job.id, player.id, analysisDepth(db)).then(() => {
      db.prepare("UPDATE import_jobs SET status = 'done', stage = 'done' WHERE id = ?").run(job.id);
    });
    res.status(202).json({ jobId: job.id });
  });

  router.get('/players/:username/games', (req, res) => {
    const player = findPlayer(db, req.params.username);
    if (!player) return res.status(404).json({ error: 'No such player' });

    const { games, total } = listGames(db, player.id, {
      timeClass: parseScope(req.query.timeClass),
      result: parseResult(req.query.result),
      opponent: req.query.opponent ? String(req.query.opponent) : undefined,
      from: optionalNumber(req.query.from),
      to: optionalNumber(req.query.to),
      analysedOnly: req.query.analysedOnly === 'true',
      limit: Math.min(optionalNumber(req.query.limit) ?? 50, 200),
      offset: optionalNumber(req.query.offset) ?? 0,
    });

    res.json({ games: games.map(stripPgn), total });
  });

  router.get('/games/:id', (req, res) => {
    const game = getGame(db, Number(req.params.id));
    if (!game) return res.status(404).json({ error: 'No such game' });
    res.json({ game, moves: getMoves(db, game.id) });
  });

  router.post('/games/:id/analyse', async (req, res) => {
    const game = getGame(db, Number(req.params.id));
    if (!game) return res.status(404).json({ error: 'No such game' });
    try {
      const depth = optionalNumber(req.body?.depth) ?? analysisDepth(db);
      const analysis = await analyseGame(pool, game.pgn, { depth });
      saveAnalysis(db, game, analysis);
      const refreshed = getGame(db, game.id)!;
      res.json({ game: refreshed, moves: getMoves(db, game.id) });
    } catch (error) {
      res.status(500).json({ error: messageOf(error) });
    }
  });

  router.get('/players/:username/dashboard', (req, res) => {
    const player = findPlayer(db, req.params.username);
    if (!player) return res.status(404).json({ error: 'No such player' });
    res.json({ player, ...dashboard(db, player.id, parseScope(req.query.scope) ?? 'all') });
  });

  router.get('/players/:username/patterns', (req, res) => {
    const player = findPlayer(db, req.params.username);
    if (!player) return res.status(404).json({ error: 'No such player' });
    const scope = parseScope(req.query.scope) ?? 'all';
    const minOccurrences = optionalNumber(req.query.min) ?? 3;
    res.json({
      scope,
      patterns: detectPatterns(db, player.id, scope, { minOccurrences }),
      labels: MOTIF_LABELS,
    });
  });

  router.get('/players/:username/coaching', async (req, res) => {
    const player = findPlayer(db, req.params.username);
    if (!player) return res.status(404).json({ error: 'No such player' });

    const scope = parseScope(req.query.scope) ?? 'all';
    if (req.query.refresh !== 'true') {
      const cached = readCachedCoaching(db, player.id, scope);
      if (cached) return res.json({ scope, coaching: cached, cached: true });
    }

    try {
      const coaching = await generateCoaching({
        username: player.username,
        scope,
        stats: dashboard(db, player.id, scope),
        patterns: detectPatterns(db, player.id, scope),
      });
      writeCachedCoaching(db, player.id, scope, coaching);
      res.json({ scope, coaching, cached: false });
    } catch (error) {
      res.status(500).json({ error: messageOf(error) });
    }
  });

  router.get('/settings', (_req, res) => {
    res.json({
      analysisDepth: analysisDepth(db),
      engine: pool.engineName,
      engines: pool.size,
      coaching: hasApiKey() ? 'claude' : 'offline',
      players: listPlayers(db),
    });
  });

  router.post('/settings', (req, res) => {
    const depth = optionalNumber(req.body?.analysisDepth);
    if (depth !== undefined) {
      if (depth < 8 || depth > 24) {
        return res.status(400).json({ error: 'Analysis depth must be between 8 and 24' });
      }
      setSetting(db, 'analysisDepth', String(Math.round(depth)));
    }
    res.json({ analysisDepth: analysisDepth(db) });
  });

  router.delete('/players/:username/games', (req, res) => {
    const player = findPlayer(db, req.params.username);
    if (!player) return res.status(404).json({ error: 'No such player' });
    deletePlayerData(db, player.id);
    res.json({ ok: true });
  });

  router.post('/players', (req, res) => {
    const username = String(req.body?.username ?? '').trim();
    if (!username) return res.status(400).json({ error: 'A username is required' });
    res.json({ player: upsertPlayer(db, username) });
  });

  return router;
}

function analysisDepth(db: DB): number {
  return Number(getSetting(db, 'analysisDepth', process.env.ANALYSIS_DEPTH ?? '16'));
}

function newestGameTime(db: DB, playerId: number): number | undefined {
  const row = db
    .prepare('SELECT MAX(end_time) AS t FROM games WHERE player_id = ?')
    .get(playerId) as { t: number | null };
  return row.t ?? undefined;
}

/** The PGN is large and the list view never renders it. */
function stripPgn<T extends { pgn: string }>(game: T): Omit<T, 'pgn'> {
  const { pgn: _pgn, ...rest } = game;
  return rest;
}

function optionalNumber(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parseScope(value: unknown): Scope | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const lower = String(value).toLowerCase();
  if (lower === 'all') return 'all';
  return (TIME_CLASSES as string[]).includes(lower) ? (lower as TimeClass) : undefined;
}

function parseResult(value: unknown): GameResult | 'all' | undefined {
  const lower = String(value ?? '').toLowerCase();
  if (lower === 'all') return 'all';
  return ['win', 'loss', 'draw'].includes(lower) ? (lower as GameResult) : undefined;
}

function parseTimeClasses(value: unknown): TimeClass[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const classes = value
    .map((v) => String(v).toLowerCase())
    .filter((v): v is TimeClass => (TIME_CLASSES as string[]).includes(v));
  return classes.length > 0 ? classes : undefined;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : 'Unexpected error';
}

export type ApiRequest = Request;
export type ApiResponse = Response;
