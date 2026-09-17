import type { DB } from './db.js';
import { outcomeFor } from './chesscom.js';
import { parsePgn } from './analysis.js';
import type { AnalysedMove, Color, GameAnalysis, GameResult, ImportedGame, TimeClass } from './types.js';

export interface PlayerRow {
  id: number;
  username: string;
  source: string;
  created_at: number;
  last_synced_at: number | null;
}

export interface GameRow {
  id: number;
  player_id: number;
  external_id: string;
  source: string;
  url: string | null;
  pgn: string;
  time_class: TimeClass;
  time_control: string;
  end_time: number;
  rated: number;
  white_username: string;
  black_username: string;
  white_rating: number | null;
  black_rating: number | null;
  eco: string | null;
  eco_name: string | null;
  player_color: Color;
  result: GameResult;
  termination: string | null;
  opponent: string;
  player_rating: number | null;
  opponent_rating: number | null;
  move_count: number;
  analysed_at: number | null;
  analysis_depth: number | null;
  engine: string | null;
  accuracy_white: number | null;
  accuracy_black: number | null;
  created_at: number;
}

export interface MoveRow {
  id: number;
  game_id: number;
  ply: number;
  move_number: number;
  color: Color;
  is_player: number;
  san: string;
  uci: string;
  fen_before: string;
  fen_after: string;
  eval_before: number;
  eval_after: number;
  mate_before: number | null;
  mate_after: number | null;
  cp_loss: number;
  win_percent_loss: number;
  accuracy: number;
  classification: string;
  best_move_uci: string | null;
  best_move_san: string | null;
  pv: string | null;
  phase: string;
  clock_after: number | null;
  time_spent: number | null;
  motifs: string;
}

export function upsertPlayer(db: DB, username: string, source = 'chess.com'): PlayerRow {
  const now = Math.floor(Date.now() / 1000);
  db.prepare(
    `INSERT INTO players (username, source, created_at)
     VALUES (?, ?, ?)
     ON CONFLICT(username) DO NOTHING`,
  ).run(username, source, now);
  return db.prepare('SELECT * FROM players WHERE username = ?').get(username) as PlayerRow;
}

export function findPlayer(db: DB, username: string): PlayerRow | undefined {
  return db.prepare('SELECT * FROM players WHERE username = ?').get(username) as
    | PlayerRow
    | undefined;
}

export function listPlayers(db: DB): PlayerRow[] {
  return db.prepare('SELECT * FROM players ORDER BY created_at').all() as PlayerRow[];
}

/**
 * Stores a game from the tracked player's point of view — colour, opponent and
 * result are resolved on the way in so that every later query is a plain filter
 * instead of a per-row "which side was I" branch.
 */
export function insertGame(db: DB, playerId: number, game: ImportedGame, username: string): number | null {
  const playerIsWhite = game.whiteUsername.toLowerCase() === username.toLowerCase();
  const playerColor: Color = playerIsWhite ? 'white' : 'black';
  const result = outcomeFor(playerIsWhite ? game.whiteResult : game.blackResult);
  const headers = safeHeaders(game.pgn);
  const moveCount = countMoves(game.pgn);

  const info = db
    .prepare(
      `INSERT INTO games (
         player_id, external_id, source, url, pgn, time_class, time_control, end_time, rated,
         white_username, black_username, white_rating, black_rating, eco, eco_name,
         player_color, result, termination, opponent, player_rating, opponent_rating,
         move_count, created_at
       ) VALUES (
         @player_id, @external_id, @source, @url, @pgn, @time_class, @time_control, @end_time, @rated,
         @white_username, @black_username, @white_rating, @black_rating, @eco, @eco_name,
         @player_color, @result, @termination, @opponent, @player_rating, @opponent_rating,
         @move_count, @created_at
       )
       ON CONFLICT (player_id, external_id) DO NOTHING`,
    )
    .run({
      player_id: playerId,
      external_id: game.externalId,
      source: game.source,
      url: game.url,
      pgn: game.pgn,
      time_class: game.timeClass,
      time_control: game.timeControl,
      end_time: game.endTime,
      rated: game.rated ? 1 : 0,
      white_username: game.whiteUsername,
      black_username: game.blackUsername,
      white_rating: game.whiteRating,
      black_rating: game.blackRating,
      eco: game.eco,
      eco_name: game.ecoName,
      player_color: playerColor,
      result,
      termination: headers.Termination ?? null,
      opponent: playerIsWhite ? game.blackUsername : game.whiteUsername,
      player_rating: playerIsWhite ? game.whiteRating : game.blackRating,
      opponent_rating: playerIsWhite ? game.blackRating : game.whiteRating,
      move_count: moveCount,
      created_at: Math.floor(Date.now() / 1000),
    });

  return info.changes > 0 ? Number(info.lastInsertRowid) : null;
}

function safeHeaders(pgn: string): Record<string, string> {
  try {
    return parsePgn(pgn).headers;
  } catch {
    return {};
  }
}

function countMoves(pgn: string): number {
  try {
    return parsePgn(pgn).moves.length;
  } catch {
    return 0;
  }
}

export function saveAnalysis(
  db: DB,
  game: Pick<GameRow, 'id' | 'player_color'>,
  analysis: GameAnalysis,
): void {
  const insertMove = db.prepare(
    `INSERT INTO moves (
       game_id, ply, move_number, color, is_player, san, uci, fen_before, fen_after,
       eval_before, eval_after, mate_before, mate_after, cp_loss, win_percent_loss, accuracy,
       classification, best_move_uci, best_move_san, pv, phase, clock_after, time_spent, motifs
     ) VALUES (
       @game_id, @ply, @move_number, @color, @is_player, @san, @uci, @fen_before, @fen_after,
       @eval_before, @eval_after, @mate_before, @mate_after, @cp_loss, @win_percent_loss, @accuracy,
       @classification, @best_move_uci, @best_move_san, @pv, @phase, @clock_after, @time_spent, @motifs
     )
     ON CONFLICT (game_id, ply) DO UPDATE SET
       eval_before = excluded.eval_before,
       eval_after = excluded.eval_after,
       cp_loss = excluded.cp_loss,
       win_percent_loss = excluded.win_percent_loss,
       accuracy = excluded.accuracy,
       classification = excluded.classification,
       best_move_uci = excluded.best_move_uci,
       best_move_san = excluded.best_move_san,
       pv = excluded.pv,
       motifs = excluded.motifs`,
  );

  const markAnalysed = db.prepare(
    `UPDATE games
        SET analysed_at = ?, analysis_depth = ?, engine = ?, accuracy_white = ?, accuracy_black = ?
      WHERE id = ?`,
  );

  const write = db.transaction((moves: AnalysedMove[]) => {
    for (const move of moves) {
      insertMove.run({
        game_id: game.id,
        ply: move.ply,
        move_number: move.moveNumber,
        color: move.color,
        is_player: move.color === game.player_color ? 1 : 0,
        san: move.san,
        uci: move.uci,
        fen_before: move.fenBefore,
        fen_after: move.fenAfter,
        eval_before: move.evalBefore,
        eval_after: move.evalAfter,
        mate_before: move.mateBefore,
        mate_after: move.mateAfter,
        cp_loss: move.centipawnLoss,
        win_percent_loss: move.winPercentLoss,
        accuracy: move.accuracy,
        classification: move.classification,
        best_move_uci: move.bestMoveUci,
        best_move_san: move.bestMoveSan,
        pv: move.pv.join(' '),
        phase: move.phase,
        clock_after: move.clockAfter,
        time_spent: move.timeSpent,
        motifs: move.motifs.join(','),
      });
    }
    markAnalysed.run(
      Math.floor(Date.now() / 1000),
      analysis.depth,
      analysis.engine,
      analysis.accuracyWhite,
      analysis.accuracyBlack,
      game.id,
    );
  });

  write(analysis.moves);
}

export function getGame(db: DB, gameId: number): GameRow | undefined {
  return db.prepare('SELECT * FROM games WHERE id = ?').get(gameId) as GameRow | undefined;
}

export function getMoves(db: DB, gameId: number): MoveRow[] {
  return db.prepare('SELECT * FROM moves WHERE game_id = ? ORDER BY ply').all(gameId) as MoveRow[];
}

export function unanalysedGames(db: DB, playerId: number, limit: number): GameRow[] {
  return db
    .prepare(
      `SELECT * FROM games
        WHERE player_id = ? AND analysed_at IS NULL
        ORDER BY end_time DESC
        LIMIT ?`,
    )
    .all(playerId, limit) as GameRow[];
}

export interface GameFilter {
  timeClass?: TimeClass | 'all';
  result?: GameResult | 'all';
  opponent?: string;
  from?: number;
  to?: number;
  analysedOnly?: boolean;
  limit?: number;
  offset?: number;
}

export function buildGameWhere(playerId: number, filter: GameFilter): {
  clause: string;
  params: unknown[];
} {
  const clauses = ['player_id = ?'];
  const params: unknown[] = [playerId];

  if (filter.timeClass && filter.timeClass !== 'all') {
    clauses.push('time_class = ?');
    params.push(filter.timeClass);
  }
  if (filter.result && filter.result !== 'all') {
    clauses.push('result = ?');
    params.push(filter.result);
  }
  if (filter.opponent) {
    clauses.push('opponent LIKE ?');
    params.push(`%${filter.opponent}%`);
  }
  if (filter.from) {
    clauses.push('end_time >= ?');
    params.push(filter.from);
  }
  if (filter.to) {
    clauses.push('end_time <= ?');
    params.push(filter.to);
  }
  if (filter.analysedOnly) clauses.push('analysed_at IS NOT NULL');

  return { clause: clauses.join(' AND '), params };
}

export function listGames(db: DB, playerId: number, filter: GameFilter = {}): {
  games: GameRow[];
  total: number;
} {
  const { clause, params } = buildGameWhere(playerId, filter);
  const total = (
    db.prepare(`SELECT COUNT(*) AS n FROM games WHERE ${clause}`).get(...params) as { n: number }
  ).n;
  const games = db
    .prepare(
      `SELECT * FROM games WHERE ${clause} ORDER BY end_time DESC LIMIT ? OFFSET ?`,
    )
    .all(...params, filter.limit ?? 50, filter.offset ?? 0) as GameRow[];
  return { games, total };
}

export function deletePlayerData(db: DB, playerId: number): void {
  db.prepare('DELETE FROM games WHERE player_id = ?').run(playerId);
  db.prepare('DELETE FROM coaching WHERE player_id = ?').run(playerId);
}
