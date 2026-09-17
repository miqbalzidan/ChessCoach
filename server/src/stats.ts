import type { DB } from './db.js';
import { round1 } from './evaluation.js';
import { TIME_CLASSES, type Phase, type TimeClass } from './types.js';

export type Scope = TimeClass | 'all';

/** Player moves in scope, joined to their game. Every stat below narrows this. */
const PLAYER_MOVES = `
  FROM moves m
  JOIN games g ON g.id = m.game_id
 WHERE g.player_id = @player AND m.is_player = 1 AND g.analysed_at IS NOT NULL
`;

function scopeClause(scope: Scope): string {
  return scope === 'all' ? '' : ' AND g.time_class = @scope';
}

function params(playerId: number, scope: Scope): Record<string, unknown> {
  return { player: playerId, scope: scope === 'all' ? null : scope };
}

export interface Headline {
  games: number;
  analysedGames: number;
  moves: number;
  blundersPerGame: number;
  blundersPerGameDelta: number | null;
  accuracy: number;
  accuracyDelta: number | null;
  medianCentipawnLoss: number;
  winRate: number;
  record: { win: number; loss: number; draw: number };
}

export function headline(db: DB, playerId: number, scope: Scope): Headline {
  const p = params(playerId, scope);
  const gameScope = scope === 'all' ? '' : ' AND time_class = @scope';

  const games = db
    .prepare(
      `SELECT
         COUNT(*) AS total,
         SUM(CASE WHEN analysed_at IS NOT NULL THEN 1 ELSE 0 END) AS analysed,
         SUM(CASE WHEN result = 'win' THEN 1 ELSE 0 END) AS wins,
         SUM(CASE WHEN result = 'loss' THEN 1 ELSE 0 END) AS losses,
         SUM(CASE WHEN result = 'draw' THEN 1 ELSE 0 END) AS draws
       FROM games WHERE player_id = @player${gameScope}`,
    )
    .get(p) as { total: number; analysed: number; wins: number; losses: number; draws: number };

  const moveStats = db
    .prepare(
      `SELECT
         COUNT(*) AS moves,
         SUM(CASE WHEN m.classification = 'blunder' THEN 1 ELSE 0 END) AS blunders,
         AVG(m.accuracy) AS mean_accuracy
       ${PLAYER_MOVES}${scopeClause(scope)}`,
    )
    .get(p) as { moves: number; blunders: number | null; mean_accuracy: number | null };

  const analysed = games.analysed ?? 0;
  const accuracy = playerAccuracy(db, playerId, scope);
  const previous = previousWindow(db, playerId, scope);

  return {
    games: games.total ?? 0,
    analysedGames: analysed,
    moves: moveStats.moves ?? 0,
    blundersPerGame: analysed > 0 ? round2((moveStats.blunders ?? 0) / analysed) : 0,
    blundersPerGameDelta: previous.blundersPerGame === null
      ? null
      : round2((analysed > 0 ? (moveStats.blunders ?? 0) / analysed : 0) - previous.blundersPerGame),
    accuracy,
    accuracyDelta: previous.accuracy === null ? null : round1(accuracy - previous.accuracy),
    medianCentipawnLoss: medianCentipawnLoss(db, playerId, scope),
    winRate: games.total > 0 ? round1(((games.wins ?? 0) / games.total) * 100) : 0,
    record: { win: games.wins ?? 0, loss: games.losses ?? 0, draw: games.draws ?? 0 },
  };
}

/** Game accuracy is stored per colour, so the player's side has to be picked out. */
function playerAccuracy(db: DB, playerId: number, scope: Scope): number {
  const gameScope = scope === 'all' ? '' : ' AND time_class = @scope';
  const row = db
    .prepare(
      `SELECT AVG(CASE WHEN player_color = 'white' THEN accuracy_white ELSE accuracy_black END) AS acc
         FROM games
        WHERE player_id = @player AND analysed_at IS NOT NULL${gameScope}`,
    )
    .get(params(playerId, scope)) as { acc: number | null };
  return row.acc === null ? 0 : round1(row.acc);
}

/**
 * The comparison window is the 30 days before the most recent game in scope, not
 * before today — a player who stopped playing in March should still see the trend
 * that was true in March.
 */
function previousWindow(
  db: DB,
  playerId: number,
  scope: Scope,
): { blundersPerGame: number | null; accuracy: number | null } {
  const gameScope = scope === 'all' ? '' : ' AND time_class = @scope';
  const latest = db
    .prepare(
      `SELECT MAX(end_time) AS latest FROM games
        WHERE player_id = @player AND analysed_at IS NOT NULL${gameScope}`,
    )
    .get(params(playerId, scope)) as { latest: number | null };
  if (latest.latest === null) return { blundersPerGame: null, accuracy: null };

  const cutoff = latest.latest - 30 * 24 * 3600;
  const p = { ...params(playerId, scope), cutoff };

  const row = db
    .prepare(
      `SELECT
         COUNT(DISTINCT g.id) AS games,
         SUM(CASE WHEN m.classification = 'blunder' THEN 1 ELSE 0 END) AS blunders
       ${PLAYER_MOVES}${scopeClause(scope)} AND g.end_time < @cutoff`,
    )
    .get(p) as { games: number; blunders: number | null };

  if (!row.games) return { blundersPerGame: null, accuracy: null };

  const acc = db
    .prepare(
      `SELECT AVG(CASE WHEN player_color = 'white' THEN accuracy_white ELSE accuracy_black END) AS acc
         FROM games
        WHERE player_id = @player AND analysed_at IS NOT NULL AND end_time < @cutoff${gameScope}`,
    )
    .get(p) as { acc: number | null };

  return {
    blundersPerGame: round2((row.blunders ?? 0) / row.games),
    accuracy: acc.acc === null ? null : round1(acc.acc),
  };
}

function medianCentipawnLoss(db: DB, playerId: number, scope: Scope): number {
  const rows = db
    .prepare(`SELECT m.cp_loss AS v ${PLAYER_MOVES}${scopeClause(scope)} ORDER BY m.cp_loss`)
    .all(params(playerId, scope)) as Array<{ v: number }>;
  if (rows.length === 0) return 0;
  const mid = Math.floor(rows.length / 2);
  if (rows.length % 2 === 1) return rows[mid]!.v;
  return Math.round((rows[mid - 1]!.v + rows[mid]!.v) / 2);
}

export interface TrendPoint {
  gameId: number;
  endTime: number;
  accuracy: number;
  blunders: number;
  mistakes: number;
  result: string;
  opponent: string;
  timeClass: TimeClass;
}

/** Newest last, so the chart reads left-to-right in time. */
export function trend(db: DB, playerId: number, scope: Scope, limit = 30): TrendPoint[] {
  const gameScope = scope === 'all' ? '' : ' AND g.time_class = @scope';
  const rows = db
    .prepare(
      `SELECT
         g.id AS gameId, g.end_time AS endTime, g.result, g.opponent, g.time_class AS timeClass,
         CASE WHEN g.player_color = 'white' THEN g.accuracy_white ELSE g.accuracy_black END AS accuracy,
         SUM(CASE WHEN m.classification = 'blunder' THEN 1 ELSE 0 END) AS blunders,
         SUM(CASE WHEN m.classification = 'mistake' THEN 1 ELSE 0 END) AS mistakes
       FROM games g
       LEFT JOIN moves m ON m.game_id = g.id AND m.is_player = 1
      WHERE g.player_id = @player AND g.analysed_at IS NOT NULL${gameScope}
      GROUP BY g.id
      ORDER BY g.end_time DESC
      LIMIT @limit`,
    )
    .all({ ...params(playerId, scope), limit }) as TrendPoint[];
  return rows.reverse();
}

export interface PhaseBreakdown {
  phase: Phase;
  inaccuracies: number;
  mistakes: number;
  blunders: number;
  total: number;
  share: number;
  moves: number;
  /** Mistakes per hundred moves played in that phase — density, not just volume. */
  rate: number;
}

export function phaseBreakdown(db: DB, playerId: number, scope: Scope): PhaseBreakdown[] {
  const rows = db
    .prepare(
      `SELECT
         m.phase,
         COUNT(*) AS moves,
         SUM(CASE WHEN m.classification = 'inaccuracy' THEN 1 ELSE 0 END) AS inaccuracies,
         SUM(CASE WHEN m.classification = 'mistake' THEN 1 ELSE 0 END) AS mistakes,
         SUM(CASE WHEN m.classification = 'blunder' THEN 1 ELSE 0 END) AS blunders
       ${PLAYER_MOVES}${scopeClause(scope)}
       GROUP BY m.phase`,
    )
    .all(params(playerId, scope)) as Array<{
    phase: Phase;
    moves: number;
    inaccuracies: number;
    mistakes: number;
    blunders: number;
  }>;

  const byPhase = new Map(rows.map((r) => [r.phase, r]));
  const phases: Phase[] = ['opening', 'middlegame', 'endgame'];
  const totals = phases.map((phase) => {
    const row = byPhase.get(phase);
    return (row?.inaccuracies ?? 0) + (row?.mistakes ?? 0) + (row?.blunders ?? 0);
  });
  const grandTotal = totals.reduce((a, b) => a + b, 0);

  return phases.map((phase, index) => {
    const row = byPhase.get(phase);
    const total = totals[index]!;
    const moves = row?.moves ?? 0;
    return {
      phase,
      inaccuracies: row?.inaccuracies ?? 0,
      mistakes: row?.mistakes ?? 0,
      blunders: row?.blunders ?? 0,
      total,
      share: grandTotal > 0 ? Math.round((total / grandTotal) * 100) : 0,
      moves,
      rate: moves > 0 ? round1((total / moves) * 100) : 0,
    };
  });
}

export interface OpeningRow {
  eco: string;
  name: string;
  color: string;
  games: number;
  wins: number;
  losses: number;
  draws: number;
  winRate: number;
  accuracy: number;
}

export function openings(db: DB, playerId: number, scope: Scope, limit = 12): OpeningRow[] {
  const gameScope = scope === 'all' ? '' : ' AND time_class = @scope';
  return db
    .prepare(
      `SELECT
         COALESCE(eco, '—') AS eco,
         COALESCE(eco_name, 'Unknown opening') AS name,
         player_color AS color,
         COUNT(*) AS games,
         SUM(CASE WHEN result = 'win'  THEN 1 ELSE 0 END) AS wins,
         SUM(CASE WHEN result = 'loss' THEN 1 ELSE 0 END) AS losses,
         SUM(CASE WHEN result = 'draw' THEN 1 ELSE 0 END) AS draws,
         ROUND(AVG(CASE WHEN player_color = 'white' THEN accuracy_white ELSE accuracy_black END), 1) AS accuracy,
         ROUND(100.0 * SUM(CASE WHEN result = 'win' THEN 1 ELSE 0 END) / COUNT(*), 1) AS winRate
       FROM games
      WHERE player_id = @player AND eco IS NOT NULL${gameScope}
      GROUP BY eco, player_color
      HAVING COUNT(*) >= 2
      ORDER BY games DESC, winRate ASC
      LIMIT @limit`,
    )
    .all({ ...params(playerId, scope), limit }) as OpeningRow[];
}

export interface ClockBucket {
  label: string;
  moves: number;
  blunders: number;
  /** Blunders per 100 moves played in this bucket. */
  rate: number;
  multiplier: number;
}

/**
 * The V3 clock-pressure finding. Buckets are seconds remaining when the move was
 * played, so "under 20 seconds" means exactly that rather than "in a fast game".
 */
export function clockPressure(db: DB, playerId: number, scope: Scope): {
  buckets: ClockBucket[];
  coverage: number;
  worstMultiplier: number;
} {
  const rows = db
    .prepare(
      `SELECT
         CASE
           WHEN m.clock_after >= 60 THEN '>60s'
           WHEN m.clock_after >= 20 THEN '60-20s'
           ELSE '<20s'
         END AS label,
         COUNT(*) AS moves,
         SUM(CASE WHEN m.classification = 'blunder' THEN 1 ELSE 0 END) AS blunders
       ${PLAYER_MOVES}${scopeClause(scope)} AND m.clock_after IS NOT NULL
       GROUP BY label`,
    )
    .all(params(playerId, scope)) as Array<{ label: string; moves: number; blunders: number }>;

  const totalWithClock = rows.reduce((sum, r) => sum + r.moves, 0);
  const allMoves = (
    db
      .prepare(`SELECT COUNT(*) AS n ${PLAYER_MOVES}${scopeClause(scope)}`)
      .get(params(playerId, scope)) as { n: number }
  ).n;

  const order = ['>60s', '60-20s', '<20s'];
  const byLabel = new Map(rows.map((r) => [r.label, r]));
  const baseline = byLabel.get('>60s');
  const baselineRate = baseline && baseline.moves > 0 ? baseline.blunders / baseline.moves : 0;

  const buckets: ClockBucket[] = order.map((label) => {
    const row = byLabel.get(label);
    const moves = row?.moves ?? 0;
    const blunders = row?.blunders ?? 0;
    const rate = moves > 0 ? (blunders / moves) * 100 : 0;
    return {
      label,
      moves,
      blunders,
      rate: round2(rate),
      multiplier: baselineRate > 0 && moves > 0 ? round1(blunders / moves / baselineRate) : 0,
    };
  });

  return {
    buckets,
    coverage: allMoves > 0 ? round1((totalWithClock / allMoves) * 100) : 0,
    worstMultiplier: Math.max(...buckets.map((b) => b.multiplier), 0),
  };
}

export interface TimeClassSummary {
  timeClass: TimeClass;
  games: number;
  analysed: number;
  accuracy: number;
  blundersPerGame: number;
  winRate: number;
}

/** Feeds the segmented control: every class shows its own count before selection. */
export function timeClassSummary(db: DB, playerId: number): TimeClassSummary[] {
  return TIME_CLASSES.map((timeClass) => {
    const head = headline(db, playerId, timeClass);
    return {
      timeClass,
      games: head.games,
      analysed: head.analysedGames,
      accuracy: head.accuracy,
      blundersPerGame: head.blundersPerGame,
      winRate: head.winRate,
    };
  });
}

export interface ClassificationCount {
  classification: string;
  count: number;
}

export function classificationCounts(
  db: DB,
  playerId: number,
  scope: Scope,
): ClassificationCount[] {
  return db
    .prepare(
      `SELECT m.classification, COUNT(*) AS count
       ${PLAYER_MOVES}${scopeClause(scope)}
       GROUP BY m.classification
       ORDER BY count DESC`,
    )
    .all(params(playerId, scope)) as ClassificationCount[];
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

export function dashboard(db: DB, playerId: number, scope: Scope) {
  return {
    scope,
    headline: headline(db, playerId, scope),
    timeClasses: timeClassSummary(db, playerId),
    trend: trend(db, playerId, scope),
    phases: phaseBreakdown(db, playerId, scope),
    openings: openings(db, playerId, scope),
    clock: clockPressure(db, playerId, scope),
    classifications: classificationCounts(db, playerId, scope),
  };
}
