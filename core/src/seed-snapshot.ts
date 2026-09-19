/**
 * Starting a phone from a computer's work.
 *
 * A snapshot was built to be *read* — frozen answers for screens with no engine
 * behind them. This puts its raw material into a real database instead, so the phone
 * owns those games and can keep adding to them.
 *
 * That is the difference that makes the phone pleasant to use. Analysing a back
 * archive on a handset is an afternoon and a flat battery; the computer already did
 * it, at a depth a phone would not attempt, and every one of those games is sitting
 * in the export. Seeding is an insert, not a recomputation.
 *
 * Two things are deliberately preserved rather than recomputed:
 *
 * - **The engine and depth each game was analysed at.** They came from a desktop
 *   Stockfish at depth 16; games added later on the phone will say 12 and a different
 *   engine. Overwriting that would make the sheet claim one instrument produced all
 *   of it, which is what `analysis_depth` and `engine` exist to prevent.
 *
 * - **Every stored number.** Accuracies, classifications, motifs and clocks are
 *   copied exactly, so a seeded phone and the computer that fed it produce the same
 *   sheet — which is the property the whole snapshot design rests on.
 */
import type { DB } from './db.js';
import type { GameRow, MoveRow, PlayerRow } from './store.js';

/**
 * What seeding needs out of a snapshot, described structurally.
 *
 * The full `Snapshot` type belongs to the client, because most of it is frozen
 * answers for screens. Core only wants the raw material — which is rows it already
 * defines — so it asks for that and stays independent of the view layer.
 */
export interface SnapshotSeed {
  player: PlayerRow;
  /** Exported games carry no PGN, and no `created_at` — the export drops the first
   *  because no screen reads it, and never carried the second. Neither is needed:
   *  a seeded game's `created_at` is the time it was played. */
  games: Array<Omit<GameRow, 'pgn' | 'created_at'> & { pgn?: string }>;
  /** Game id as a string, because this arrives as JSON. */
  moves: Record<string, MoveRow[]>;
}

export interface SeedResult {
  player: string;
  /** Games written. Games already present are not counted, and not touched. */
  games: number;
  moves: number;
  /** Games skipped because this database already had them. */
  duplicates: number;
  /** True when the games carry analysis from more than one engine or depth. */
  mixedAnalysis: boolean;
}

const GAME_COLUMNS = [
  'player_id',
  'external_id',
  'source',
  'url',
  'pgn',
  'time_class',
  'time_control',
  'end_time',
  'rated',
  'white_username',
  'black_username',
  'white_rating',
  'black_rating',
  'eco',
  'eco_name',
  'player_color',
  'result',
  'termination',
  'opponent',
  'player_rating',
  'opponent_rating',
  'move_count',
  'analysed_at',
  'analysis_depth',
  'engine',
  'accuracy_white',
  'accuracy_black',
  'created_at',
] as const;

const MOVE_COLUMNS = [
  'game_id',
  'ply',
  'move_number',
  'color',
  'is_player',
  'san',
  'uci',
  'fen_before',
  'fen_after',
  'eval_before',
  'eval_after',
  'mate_before',
  'mate_after',
  'cp_loss',
  'win_percent_loss',
  'accuracy',
  'classification',
  'best_move_uci',
  'best_move_san',
  'pv',
  'phase',
  'clock_after',
  'time_spent',
  'motifs',
] as const;

function placeholders(columns: readonly string[]): string {
  return columns.map((column) => `@${column}`).join(', ');
}

/**
 * Writes a snapshot's games into this database, skipping any it already holds.
 *
 * Idempotent on purpose: re-seeding from a newer export should add the games played
 * since and leave the rest alone, rather than duplicating a history or demanding the
 * person wipe the phone first.
 */
export function seedFromSnapshot(db: DB, snapshot: SnapshotSeed): SeedResult {
  const player = ensurePlayer(db, snapshot.player);

  const existing = new Set(
    (
      db
        .prepare('SELECT external_id FROM games WHERE player_id = ?')
        .all(player.id) as Array<{ external_id: string }>
    ).map((row) => row.external_id),
  );

  const insertGame = db.prepare(
    `INSERT INTO games (${GAME_COLUMNS.join(', ')}) VALUES (${placeholders(GAME_COLUMNS)})`,
  );
  const insertMove = db.prepare(
    `INSERT INTO moves (${MOVE_COLUMNS.join(', ')}) VALUES (${placeholders(MOVE_COLUMNS)})`,
  );

  const result: SeedResult = {
    player: player.username,
    games: 0,
    moves: 0,
    duplicates: 0,
    mixedAnalysis: false,
  };
  const signatures = new Set<string>();

  // One transaction: a half-seeded database would show a sheet drawn from part of a
  // history, which is worse than a failed import you can retry.
  const write = db.transaction(() => {
    for (const game of snapshot.games) {
      if (existing.has(game.external_id)) {
        result.duplicates += 1;
        continue;
      }

      // The snapshot's own id is not reused: this database may already have one.
      const info = insertGame.run(gameRow(game, player.id));
      const gameId = Number(info.lastInsertRowid);
      result.games += 1;
      if (game.analysed_at) signatures.add(`${game.engine ?? '?'}@${game.analysis_depth ?? '?'}`);

      for (const move of snapshot.moves[String(game.id)] ?? []) {
        insertMove.run(moveRow(move, gameId));
        result.moves += 1;
      }
    }
  });
  write();

  result.mixedAnalysis = signatures.size > 1;
  return result;
}

function ensurePlayer(db: DB, player: PlayerRow): { id: number; username: string } {
  const found = db
    .prepare('SELECT id, username FROM players WHERE username = ?')
    .get(player.username) as { id: number; username: string } | undefined;
  if (found) return found;

  const info = db
    .prepare(
      'INSERT INTO players (username, source, created_at, last_synced_at) VALUES (?, ?, ?, ?)',
    )
    .run(player.username, player.source, player.created_at, player.last_synced_at);
  return { id: Number(info.lastInsertRowid), username: player.username };
}

function gameRow(game: SnapshotSeed['games'][number], playerId: number): Record<string, unknown> {
  return {
    player_id: playerId,
    external_id: game.external_id,
    source: game.source,
    url: game.url,
    // Exports drop the PGN — no screen reads it, and it is a tenth of the payload.
    // A seeded game can therefore be read but not re-analysed at another depth, which
    // it does not need: it was analysed properly the first time.
    pgn: game.pgn ?? '',
    time_class: game.time_class,
    time_control: game.time_control,
    end_time: game.end_time,
    rated: game.rated,
    white_username: game.white_username,
    black_username: game.black_username,
    white_rating: game.white_rating,
    black_rating: game.black_rating,
    eco: game.eco,
    eco_name: game.eco_name,
    player_color: game.player_color,
    result: game.result,
    termination: game.termination,
    opponent: game.opponent,
    player_rating: game.player_rating,
    opponent_rating: game.opponent_rating,
    move_count: game.move_count,
    analysed_at: game.analysed_at,
    analysis_depth: game.analysis_depth,
    engine: game.engine,
    accuracy_white: game.accuracy_white,
    accuracy_black: game.accuracy_black,
    created_at: game.end_time,
  };
}

function moveRow(move: MoveRow, gameId: number): Record<string, unknown> {
  return {
    game_id: gameId,
    ply: move.ply,
    move_number: move.move_number,
    color: move.color,
    is_player: move.is_player,
    san: move.san,
    uci: move.uci,
    fen_before: move.fen_before,
    fen_after: move.fen_after,
    eval_before: move.eval_before,
    eval_after: move.eval_after,
    mate_before: move.mate_before,
    mate_after: move.mate_after,
    cp_loss: move.cp_loss,
    win_percent_loss: move.win_percent_loss,
    accuracy: move.accuracy,
    classification: move.classification,
    best_move_uci: move.best_move_uci,
    best_move_san: move.best_move_san,
    pv: move.pv,
    phase: move.phase,
    clock_after: move.clock_after,
    time_spent: move.time_spent,
    motifs: move.motifs,
  };
}
