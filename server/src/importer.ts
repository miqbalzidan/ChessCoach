import type { DB } from './db.js';
import type { EnginePool } from './engine.js';
import { ChessComError, fetchGames, normaliseGame } from './chesscom.js';
import { analyseGame, parsePgn } from './analysis.js';
import { insertGame, saveAnalysis, unanalysedGames, upsertPlayer } from './store.js';
import { ecoNameFromHeaders } from './chesscom.js';
import type { ImportedGame, TimeClass } from './types.js';

export type JobStatus = 'queued' | 'running' | 'done' | 'error';
export type JobStage = 'queued' | 'fetching' | 'importing' | 'analysing' | 'done' | 'error';

export interface JobRow {
  id: number;
  player_id: number | null;
  username: string;
  status: JobStatus;
  stage: JobStage;
  imported: number;
  analysed: number;
  total: number;
  message: string | null;
  created_at: number;
  updated_at: number;
}

export interface ImportRequest {
  username: string;
  since?: number;
  until?: number;
  limit?: number;
  timeClasses?: TimeClass[];
  depth?: number;
}

export function createJob(db: DB, username: string): JobRow {
  const now = Math.floor(Date.now() / 1000);
  const info = db
    .prepare(
      `INSERT INTO import_jobs (username, status, stage, created_at, updated_at)
       VALUES (?, 'queued', 'queued', ?, ?)`,
    )
    .run(username, now, now);
  return getJob(db, Number(info.lastInsertRowid))!;
}

export function getJob(db: DB, id: number): JobRow | undefined {
  return db.prepare('SELECT * FROM import_jobs WHERE id = ?').get(id) as JobRow | undefined;
}

export function latestJob(db: DB, username: string): JobRow | undefined {
  return db
    .prepare('SELECT * FROM import_jobs WHERE username = ? ORDER BY id DESC LIMIT 1')
    .get(username) as JobRow | undefined;
}

function updateJob(db: DB, id: number, patch: Partial<Omit<JobRow, 'id'>>): void {
  const fields = Object.keys(patch);
  if (fields.length === 0) return;
  const assignments = fields.map((f) => `${f} = @${f}`).join(', ');
  db.prepare(`UPDATE import_jobs SET ${assignments}, updated_at = @updated_at WHERE id = @id`).run({
    ...patch,
    id,
    updated_at: Math.floor(Date.now() / 1000),
  });
}

/**
 * Runs the whole import out of band: fetch, store, then analyse. Progress lands in
 * import_jobs so the UI can show a real stage rather than an indeterminate spinner.
 */
export async function runImport(
  db: DB,
  pool: EnginePool,
  jobId: number,
  request: ImportRequest,
): Promise<void> {
  const username = request.username.trim();
  try {
    updateJob(db, jobId, { status: 'running', stage: 'fetching', message: null });
    const player = upsertPlayer(db, username);
    updateJob(db, jobId, { player_id: player.id });

    const games = await fetchGames(username, {
      since: request.since,
      until: request.until,
      limit: request.limit,
      timeClasses: request.timeClasses,
    });

    updateJob(db, jobId, { stage: 'importing', total: games.length });

    let imported = 0;
    for (const game of games) {
      if (insertGame(db, player.id, game, username) !== null) imported += 1;
      updateJob(db, jobId, { imported });
    }

    db.prepare('UPDATE players SET last_synced_at = ? WHERE id = ?').run(
      Math.floor(Date.now() / 1000),
      player.id,
    );

    await analysePending(db, pool, jobId, player.id, request.depth);
    updateJob(db, jobId, { status: 'done', stage: 'done' });
  } catch (error) {
    const message =
      error instanceof ChessComError
        ? error.message
        : error instanceof Error
          ? error.message
          : 'Import failed';
    updateJob(db, jobId, { status: 'error', stage: 'error', message });
  }
}

export async function analysePending(
  db: DB,
  pool: EnginePool,
  jobId: number,
  playerId: number,
  depth?: number,
): Promise<void> {
  const pending = unanalysedGames(db, playerId, 1000);
  updateJob(db, jobId, { stage: 'analysing', total: pending.length, analysed: 0 });

  let analysed = 0;
  for (const game of pending) {
    try {
      const analysis = await analyseGame(pool, game.pgn, { depth });
      saveAnalysis(db, game, analysis);
    } catch (error) {
      // One unparseable game should not abandon the rest of the import.
      const message = error instanceof Error ? error.message : String(error);
      updateJob(db, jobId, { message: `Skipped game ${game.id}: ${message}` });
    }
    analysed += 1;
    updateJob(db, jobId, { analysed });
  }
}

/**
 * The manual path: one or more PGNs pasted in. Games are split on the blank line
 * before the next Event tag so a whole exported archive can be pasted at once.
 */
export function gamesFromPgnText(text: string, username: string): ImportedGame[] {
  const chunks = splitPgns(text);
  const games: ImportedGame[] = [];

  for (const chunk of chunks) {
    let parsed;
    try {
      parsed = parsePgn(chunk);
    } catch {
      continue;
    }
    if (parsed.moves.length === 0) continue;

    const headers = parsed.headers;
    const white = headers.White ?? 'white';
    const black = headers.Black ?? 'black';
    const normalised = normaliseGame(
      {
        pgn: chunk,
        time_control: headers.TimeControl ?? '-',
        time_class: inferTimeClass(headers.TimeControl),
        rules: 'chess',
        rated: true,
        white: { username: white, rating: Number(headers.WhiteElo) || undefined },
        black: { username: black, rating: Number(headers.BlackElo) || undefined },
        uuid: `pgn:${hash(chunk)}`,
      },
      username,
    );
    if (!normalised) continue;
    games.push({ ...normalised, source: 'pgn', ecoName: ecoNameFromHeaders(headers) });
  }

  return games;
}

export function splitPgns(text: string): string[] {
  const normalised = text.replace(/\r\n/g, '\n').trim();
  if (!normalised) return [];
  // A new game starts at an [Event ...] tag that follows a blank line.
  const parts = normalised.split(/\n\s*\n(?=\[Event )/g);
  return parts.map((p) => p.trim()).filter(Boolean);
}

/**
 * Pasted PGNs carry a time control but not Chess.com's time_class, so the class is
 * derived from the same base+increment rule Chess.com uses.
 */
export function inferTimeClass(timeControl: string | undefined): TimeClass {
  if (!timeControl || timeControl === '-') return 'daily';
  if (timeControl.includes('/')) return 'daily';

  const [baseRaw, incRaw] = timeControl.split('+');
  const base = Number(baseRaw);
  const increment = Number(incRaw ?? 0);
  if (!Number.isFinite(base)) return 'daily';

  const estimated = base + 40 * (Number.isFinite(increment) ? increment : 0);
  if (estimated < 180) return 'bullet';
  if (estimated < 600) return 'blitz';
  if (estimated < 86400) return 'rapid';
  return 'daily';
}

function hash(input: string): string {
  let h = 2166136261;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

export async function runPgnImport(
  db: DB,
  pool: EnginePool,
  jobId: number,
  username: string,
  pgnText: string,
  depth?: number,
): Promise<void> {
  try {
    updateJob(db, jobId, { status: 'running', stage: 'importing', message: null });
    const player = upsertPlayer(db, username, 'pgn');
    updateJob(db, jobId, { player_id: player.id });

    const games = gamesFromPgnText(pgnText, username);
    if (games.length === 0) throw new Error('No valid games found in that PGN');

    updateJob(db, jobId, { total: games.length });
    let imported = 0;
    for (const game of games) {
      if (insertGame(db, player.id, game, username) !== null) imported += 1;
      updateJob(db, jobId, { imported });
    }

    await analysePending(db, pool, jobId, player.id, depth);
    updateJob(db, jobId, { status: 'done', stage: 'done' });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Import failed';
    updateJob(db, jobId, { status: 'error', stage: 'error', message });
  }
}
