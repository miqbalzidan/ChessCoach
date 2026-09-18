/**
 * The scouting report: what you are good at, and what someone would aim at to beat
 * you.
 *
 * Everywhere it can, this measures you against *the opponents in your own games*
 * rather than an absolute bar. Someone at 1200 and someone at 2000 both blunder;
 * what matters is whether you blunder more than the people across the board from
 * you. That baseline comes free, and it moves as you improve.
 *
 * Every trait carries the number that produced it. A profile that says "good
 * endgames" without saying how it knows is a horoscope.
 */
import type { DB } from './db.js';
import { round1 } from './evaluation.js';
import type { Phase, TimeClass } from './types.js';

export type Scope = TimeClass | 'all';

function scopeClause(scope: Scope): string {
  return scope === 'all' ? '' : ' AND g.time_class = @scope';
}

function params(playerId: number, scope: Scope): Record<string, unknown> {
  return { player: playerId, scope: scope === 'all' ? null : scope };
}

export interface Trait {
  key: string;
  title: string;
  /** One sentence on what it means in play. */
  detail: string;
  /** The measurement behind it, shown next to the claim. */
  evidence: string;
  /** How far from par, used only for ordering. */
  weight: number;
}

export interface Profile {
  strengths: Trait[];
  weaknesses: Trait[];
  /** How many analysed games the report is drawn from. */
  games: number;
  /** True when there is too little to say anything responsibly. */
  thin: boolean;
}

/** Below this, a signal is noise dressed as a finding. */
const MIN_GAMES = 8;
const MIN_MOVES = 25;
const MIN_OPENING_GAMES = 4;

interface PhaseRow {
  phase: Phase;
  mine: number | null;
  theirs: number | null;
  moves: number;
}

const PHASE_LABELS: Record<Phase, string> = {
  opening: 'the opening',
  middlegame: 'the middlegame',
  endgame: 'the endgame',
};

export function profile(db: DB, playerId: number, scope: Scope): Profile {
  const p = params(playerId, scope);
  const strengths: Trait[] = [];
  const weaknesses: Trait[] = [];

  const games = (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM games g
          WHERE g.player_id = @player AND g.analysed_at IS NOT NULL${scopeClause(scope)}`,
      )
      .get(p) as { n: number }
  ).n;

  if (games < MIN_GAMES) {
    return { strengths, weaknesses, games, thin: true };
  }

  addPhaseTraits(db, p, scope, strengths, weaknesses);
  addAccuracyTrait(db, p, scope, strengths, weaknesses);
  addResultTraits(db, p, scope, strengths, weaknesses);
  addClockTrait(db, p, scope, strengths, weaknesses);
  addOpeningTraits(db, p, scope, strengths, weaknesses);

  // Strongest signal first; a report is only useful if the top line is the big one.
  strengths.sort((a, b) => b.weight - a.weight);
  weaknesses.sort((a, b) => b.weight - a.weight);

  return { strengths, weaknesses, games, thin: false };
}

/** Where you out-play, or get out-played by, the people you actually face. */
function addPhaseTraits(
  db: DB,
  p: Record<string, unknown>,
  scope: Scope,
  strengths: Trait[],
  weaknesses: Trait[],
): void {
  const rows = db
    .prepare(
      `SELECT m.phase AS phase,
              AVG(CASE WHEN m.is_player = 1 THEN m.accuracy END) AS mine,
              AVG(CASE WHEN m.is_player = 0 THEN m.accuracy END) AS theirs,
              SUM(CASE WHEN m.is_player = 1 THEN 1 ELSE 0 END) AS moves
         FROM moves m
         JOIN games g ON g.id = m.game_id
        WHERE g.player_id = @player AND g.analysed_at IS NOT NULL${scopeClause(scope)}
        GROUP BY m.phase`,
    )
    .all(p) as PhaseRow[];

  for (const row of rows) {
    if (row.mine === null || row.theirs === null || row.moves < MIN_MOVES) continue;
    const gap = row.mine - row.theirs;
    if (Math.abs(gap) < 3) continue;

    const where = PHASE_LABELS[row.phase] ?? row.phase;
    const evidence = `${round1(row.mine)}% vs their ${round1(row.theirs)}% over ${row.moves} moves`;

    if (gap > 0) {
      strengths.push({
        key: `phase-${row.phase}`,
        title: `Strong in ${where}`,
        detail: `You play ${where} more accurately than the people you face.`,
        evidence,
        weight: gap,
      });
    } else {
      weaknesses.push({
        key: `phase-${row.phase}`,
        title: `Outplayed in ${where}`,
        detail: `Your opponents are more accurate than you in ${where} — that is where to take you.`,
        evidence,
        weight: -gap,
      });
    }
  }
}

/** Overall move quality against the same field. */
function addAccuracyTrait(
  db: DB,
  p: Record<string, unknown>,
  scope: Scope,
  strengths: Trait[],
  weaknesses: Trait[],
): void {
  const row = db
    .prepare(
      `SELECT AVG(CASE WHEN m.is_player = 1 THEN m.accuracy END) AS mine,
              AVG(CASE WHEN m.is_player = 0 THEN m.accuracy END) AS theirs,
              AVG(CASE WHEN m.is_player = 1 THEN
                   CASE WHEN m.classification = 'best' THEN 1.0 ELSE 0.0 END END) AS bestRate,
              AVG(CASE WHEN m.is_player = 0 THEN
                   CASE WHEN m.classification = 'best' THEN 1.0 ELSE 0.0 END END) AS theirBestRate
         FROM moves m
         JOIN games g ON g.id = m.game_id
        WHERE g.player_id = @player AND g.analysed_at IS NOT NULL${scopeClause(scope)}`,
    )
    .get(p) as { mine: number | null; theirs: number | null; bestRate: number | null; theirBestRate: number | null };

  if (row.mine === null || row.theirs === null) return;
  const gap = row.mine - row.theirs;
  if (Math.abs(gap) < 2) return;

  const best = row.bestRate === null ? null : Math.round(row.bestRate * 100);
  const theirBest = row.theirBestRate === null ? null : Math.round(row.theirBestRate * 100);
  const evidence =
    best !== null && theirBest !== null
      ? `${round1(row.mine)}% vs ${round1(row.theirs)}% · engine move ${best}% of the time to their ${theirBest}%`
      : `${round1(row.mine)}% vs ${round1(row.theirs)}%`;

  if (gap > 0) {
    strengths.push({
      key: 'accuracy-vs-field',
      title: 'You out-play your field',
      detail: 'Move for move you are more accurate than the opponents you are paired with.',
      evidence,
      weight: gap,
    });
  } else {
    weaknesses.push({
      key: 'accuracy-vs-field',
      title: 'Out-played move for move',
      detail: 'Your opponents find better moves than you do across the board, not just in one phase.',
      evidence,
      weight: -gap,
    });
  }
}

interface GameSwing {
  result: string;
  best: number;
  worst: number;
}

/** Whether you finish won games, and whether you save lost ones. */
function addResultTraits(
  db: DB,
  p: Record<string, unknown>,
  scope: Scope,
  strengths: Trait[],
  weaknesses: Trait[],
): void {
  const rows = db
    .prepare(
      `SELECT g.result AS result,
              MAX(CASE WHEN m.color = g.player_color THEN m.eval_after ELSE -m.eval_after END) AS best,
              MIN(CASE WHEN m.color = g.player_color THEN m.eval_after ELSE -m.eval_after END) AS worst
         FROM games g
         JOIN moves m ON m.game_id = g.id
        WHERE g.player_id = @player AND g.analysed_at IS NOT NULL${scopeClause(scope)}
        GROUP BY g.id`,
    )
    .all(p) as GameSwing[];

  // A rook up, give or take — the point at which a game is supposed to be over.
  const WINNING = 200;
  const LOSING = -200;

  const won = rows.filter((row) => row.best >= WINNING);
  if (won.length >= 4) {
    const converted = won.filter((row) => row.result === 'win').length;
    const rate = (converted / won.length) * 100;
    const evidence = `${converted} of ${won.length} winning positions turned into wins`;
    if (rate >= 80) {
      strengths.push({
        key: 'conversion',
        title: 'You finish what you win',
        detail: 'Once you are clearly ahead the game tends to stay won.',
        evidence,
        weight: (rate - 80) / 4 + 2,
      });
    } else if (rate <= 60) {
      weaknesses.push({
        key: 'conversion',
        title: 'Winning positions slip',
        detail: 'Getting ahead is not the problem — staying ahead is. Trade down and make you prove it.',
        evidence,
        weight: (60 - rate) / 4 + 2,
      });
    }
  }

  const lost = rows.filter((row) => row.worst <= LOSING);
  if (lost.length >= 4) {
    const saved = lost.filter((row) => row.result !== 'loss').length;
    const rate = (saved / lost.length) * 100;
    const evidence = `${saved} of ${lost.length} losing positions saved`;
    if (rate >= 20) {
      strengths.push({
        key: 'resilience',
        title: 'Hard to finish off',
        detail: 'You rescue a real share of the games where you were already worse.',
        evidence,
        weight: rate / 8 + 1,
      });
    } else if (rate <= 5) {
      weaknesses.push({
        key: 'resilience',
        title: 'Once behind, you stay behind',
        detail: 'A clear advantage against you is usually the end of it — press early and hold on.',
        evidence,
        weight: 3,
      });
    }
  }
}

/** What the clock does to you. */
function addClockTrait(
  db: DB,
  p: Record<string, unknown>,
  scope: Scope,
  strengths: Trait[],
  weaknesses: Trait[],
): void {
  const row = db
    .prepare(
      `SELECT
         AVG(CASE WHEN m.clock_after < 20 THEN
              CASE WHEN m.classification = 'blunder' THEN 1.0 ELSE 0.0 END END) AS scramble,
         AVG(CASE WHEN m.clock_after >= 60 THEN
              CASE WHEN m.classification = 'blunder' THEN 1.0 ELSE 0.0 END END) AS calm,
         SUM(CASE WHEN m.clock_after < 20 THEN 1 ELSE 0 END) AS scrambleMoves
        FROM moves m
        JOIN games g ON g.id = m.game_id
       WHERE g.player_id = @player AND m.is_player = 1 AND g.analysed_at IS NOT NULL
         AND m.clock_after IS NOT NULL${scopeClause(scope)}`,
    )
    .get(p) as { scramble: number | null; calm: number | null; scrambleMoves: number };

  if (row.scramble === null || row.calm === null || !row.calm || row.scrambleMoves < MIN_MOVES) {
    return;
  }

  const multiplier = row.scramble / row.calm;
  const evidence = `${(row.scramble * 100).toFixed(1)}% of moves under 20s against ${(row.calm * 100).toFixed(1)}% with time`;

  if (multiplier >= 1.6) {
    weaknesses.push({
      key: 'clock',
      title: 'You crack in a scramble',
      detail: 'Your blunder rate multiplies when the clock is low. Keep the position complicated and take the game there.',
      evidence: `${multiplier.toFixed(1)}× — ${evidence}`,
      weight: multiplier,
    });
  } else if (multiplier <= 1.1) {
    strengths.push({
      key: 'clock',
      title: 'Steady on the clock',
      detail: 'Time pressure barely changes how well you play, so waiting for you to panic will not work.',
      evidence: `${multiplier.toFixed(1)}× — ${evidence}`,
      weight: 2 / Math.max(multiplier, 0.4),
    });
  }
}

interface OpeningRow {
  eco: string;
  name: string | null;
  games: number;
  score: number;
}

/** Which openings work for you, and which to steer you into. */
function addOpeningTraits(
  db: DB,
  p: Record<string, unknown>,
  scope: Scope,
  strengths: Trait[],
  weaknesses: Trait[],
): void {
  const rows = db
    .prepare(
      `SELECT g.eco AS eco, MAX(g.eco_name) AS name, COUNT(*) AS games,
              AVG(CASE g.result WHEN 'win' THEN 1.0 WHEN 'draw' THEN 0.5 ELSE 0.0 END) AS score
         FROM games g
        WHERE g.player_id = @player AND g.analysed_at IS NOT NULL AND g.eco IS NOT NULL
              ${scopeClause(scope)}
        GROUP BY g.eco
       HAVING COUNT(*) >= ${MIN_OPENING_GAMES}
        ORDER BY score DESC`,
    )
    .all(p) as OpeningRow[];

  if (rows.length === 0) return;

  const best = rows[0];
  if (best && best.score >= 0.65) {
    strengths.push({
      key: `opening-${best.eco}`,
      title: `Comfortable in ${best.name ?? best.eco}`,
      detail: 'You score well here — an opponent who knows this will avoid it.',
      evidence: `${Math.round(best.score * 100)}% across ${best.games} games (${best.eco})`,
      weight: (best.score - 0.5) * 10,
    });
  }

  const worst = rows[rows.length - 1];
  if (worst && worst !== best && worst.score <= 0.35) {
    weaknesses.push({
      key: `opening-${worst.eco}`,
      title: `Struggles in ${worst.name ?? worst.eco}`,
      detail: 'This is the opening to aim for against you.',
      evidence: `${Math.round(worst.score * 100)}% across ${worst.games} games (${worst.eco})`,
      weight: (0.5 - worst.score) * 10,
    });
  }
}
