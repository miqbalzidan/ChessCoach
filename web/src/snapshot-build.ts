/**
 * Freezes an analysed player into a snapshot: every number the read-only screens
 * ask for, already computed.
 *
 * This is the transfer format. A snapshot is what the exporter writes, what a
 * read-only sheet is served from, and — since seeding — what a phone starts its own
 * database from. Which is why it lives here rather than in the server: the phone runs
 * the same analysis in a Worker, and a phone with no computer behind it has exactly
 * one copy of its games. Being able to write this file is the only backup it has.
 *
 * Nothing in here recomputes anything. It calls exactly the functions the HTTP API
 * calls and serialises what they return, so a snapshot cannot disagree with the live
 * app. It touches no filesystem, no network and no Node built-in, so it runs on
 * either side of the seam; the parts that do — gzip, writing a file, wrapping the
 * built app around it — stay in `server/src/export.ts`.
 */
import type { DB } from '../../core/src/db.js';
import { getSetting } from '../../core/src/db.js';
import { findPlayer, getMoves, listGames } from '../../core/src/store.js';
import { dashboard, openings } from '../../core/src/stats.js';
import { detectPatterns } from '../../core/src/patterns.js';
import { profile } from '../../core/src/profile.js';
import { MOTIF_LABELS } from '../../core/src/motifs.js';
import { readCachedCoaching, writeCachedCoaching } from '../../core/src/coach.js';
import type { Coaching, Lens, Scope, Snapshot, SnapshotScope } from './types.js';
import { lensKey, SNAPSHOT_VERSION } from './types.js';

const SCOPES: Scope[] = ['all', 'bullet', 'blitz', 'rapid', 'daily'];
const MIN_OCCURRENCES = 3;

/** Games are listed without their PGN — no screen reads it, and it is 10% of the payload. */
function stripPgn<T extends { pgn: string }>(game: T): Omit<T, 'pgn'> {
  const { pgn: _pgn, ...rest } = game;
  return rest;
}

export interface BuildOptions {
  /**
   * Fill in coaching a lens has not got yet.
   *
   * Injected rather than imported, because the only implementation that can do it
   * calls Claude over the network — which the server has and the phone does not.
   * Left out, cached coaching is used where it exists and the rest stays null, which
   * is what the offline summariser already handles.
   */
  generateCoaching?: (input: {
    username: string;
    lens: Lens;
    stats: ReturnType<typeof dashboard>;
    patterns: ReturnType<typeof detectPatterns>;
  }) => Promise<Coaching>;
  /** What to record as the analysis depth when the database has no setting. */
  defaultDepth?: string;
  onProgress?: (message: string) => void;
}

export async function buildSnapshot(
  db: DB,
  username: string,
  options: BuildOptions = {},
): Promise<Snapshot> {
  const player = findPlayer(db, username);
  if (!player) throw new Error(`No such player: ${username}`);
  const note = options.onProgress ?? (() => {});

  // Everything, not a page of it — the snapshot is the whole sheet.
  const { games } = listGames(db, player.id, { limit: Number.MAX_SAFE_INTEGER, offset: 0 });
  note(`${games.length} games`);

  const moves: Record<string, ReturnType<typeof getMoves>> = {};
  for (const game of games) {
    if (game.analysed_at) moves[String(game.id)] = getMoves(db, game.id);
  }
  note(`${Object.values(moves).reduce((sum, list) => sum + list.length, 0)} moves`);

  // The phone can compute nothing, so a lens that is not exported cannot be looked
  // through. Every lens the picker can reach is written: each time class, and each
  // opening that time class offers as a menu entry.
  const lenses: Record<string, SnapshotScope> = {};
  for (const lens of lensesToExport(db, player.id)) {
    const stats = dashboard(db, player.id, lens);
    const patterns = detectPatterns(db, player.id, lens, { minOccurrences: MIN_OCCURRENCES });

    let coaching = readCachedCoaching(db, player.id, lens);
    if (!coaching && options.generateCoaching && stats.headline.analysedGames > 0) {
      note(`coaching for ${lensKey(lens)}…`);
      coaching = await options.generateCoaching({ username: player.username, lens, stats, patterns });
      writeCachedCoaching(db, player.id, lens, coaching);
    }

    // The dashboard endpoint answers with the player spread in alongside the stats,
    // so the snapshot has to carry the same shape or the screens read undefined.
    lenses[lensKey(lens)] = {
      dashboard: { player, ...stats } as SnapshotScope['dashboard'],
      patterns: patterns as SnapshotScope['patterns'],
      labels: MOTIF_LABELS,
      coaching: coaching as SnapshotScope['coaching'],
      profile: profile(db, player.id, lens) as SnapshotScope['profile'],
    };
    note(`${lensKey(lens)}: ${patterns.length} patterns`);
  }

  return {
    version: SNAPSHOT_VERSION,
    generatedAt: Math.floor(Date.now() / 1000),
    engine: engineOf(games),
    analysisDepth: Number(getSetting(db, 'analysisDepth', options.defaultDepth ?? '16')),
    minOccurrences: MIN_OCCURRENCES,
    player,
    games: games.map(stripPgn),
    moves,
    lenses,
  } as Snapshot;
}

/**
 * Every lens the reader can be asked for.
 *
 * Not just the openings each time class offers: an opening picked under one time
 * class stays picked when you move to another, so the set has to be the product of
 * the two, not the diagonal. A lens the file lacks is a screen with no numbers and
 * no way back, so completeness here is what keeps that unreachable — the reader
 * offers only what is written, and this writes everything that can be offered.
 *
 * It stays small because the menu already demands a real sample: the union across
 * the five time classes is a dozen or so openings, and an empty combination costs a
 * few hundred bytes.
 */
function lensesToExport(db: DB, playerId: number): Lens[] {
  const menu = new Map<string, { eco: string; color: 'white' | 'black' }>();
  for (const scope of SCOPES) {
    for (const opening of openings(db, playerId, { scope })) {
      const entry = { eco: opening.eco, color: opening.color as 'white' | 'black' };
      menu.set(`${entry.eco}:${entry.color}`, entry);
    }
  }

  const list: Lens[] = [];
  for (const scope of SCOPES) {
    list.push({ scope });
    for (const entry of menu.values()) list.push({ scope, ...entry });
  }
  return list;
}

function engineOf(games: Array<{ engine: string | null }>): string {
  for (const game of games) if (game.engine) return game.engine;
  return 'unknown engine';
}
