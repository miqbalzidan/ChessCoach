import type { DB } from './db.js';
import { round1 } from './evaluation.js';
import { MOTIF_LABELS } from './motifs.js';
import { lensClause, lensParams, type Lens } from './lens.js';
import type { Phase, TimeClass } from './types.js';

/**
 * Rating cost is derived, not guessed. A drop in winning chances is a drop in
 * expected score, and the Elo consequence of losing expected score is K times it.
 * Chess.com uses K≈10 for established ratings, so that is the constant here.
 */
const ELO_K = 10;

export interface PatternExample {
  gameId: number;
  ply: number;
  moveNumber: number;
  san: string;
  bestMoveSan: string | null;
  fenBefore: string;
  uci: string;
  bestMoveUci: string | null;
  opponent: string;
  timeClass: TimeClass;
  endTime: number;
  winPercentLoss: number;
  clockAfter: number | null;
  eco: string | null;
  ecoName: string | null;
  /** Which side the player had, so the board can be shown from their view. */
  playerColor: 'white' | 'black';
}

export interface Pattern {
  key: string;
  motif: string;
  title: string;
  glyph: '??' | '?' | '?!';
  occurrences: number;
  gamesAffected: number;
  blunders: number;
  mistakes: number;
  inaccuracies: number;
  /** Dominant phase and its share of the pattern's occurrences. */
  phase: Phase;
  phaseShare: number;
  timeClasses: TimeClass[];
  /** Total expected score lost to this pattern, in points. */
  pointsLost: number;
  eloCost: number;
  averageWinPercentLoss: number;
  medianSecondsLeft: number | null;
  /** Share of occurrences played with under 20 seconds on the clock. */
  timeScrambleShare: number | null;
  topOpening: { eco: string; name: string; count: number } | null;
  /** What the player is doing wrong, independent of how often. */
  mechanism: string;
  suggestion: string;
  examples: PatternExample[];
}

interface MistakeRow {
  game_id: number;
  ply: number;
  move_number: number;
  san: string;
  uci: string;
  best_move_san: string | null;
  best_move_uci: string | null;
  fen_before: string;
  classification: string;
  win_percent_loss: number;
  phase: Phase;
  motifs: string;
  clock_after: number | null;
  time_class: TimeClass;
  opponent: string;
  end_time: number;
  eco: string | null;
  eco_name: string | null;
  player_color: 'white' | 'black';
}

/**
 * Why each leak happens. The stats already say how often and where; this says what
 * the player is actually doing, so the offline summary reads as a diagnosis rather
 * than a second copy of the numbers beside it.
 */
const MECHANISMS: Record<string, string> = {
  'hung-piece':
    'You are calculating your own plan and not the reply. The piece is not trapped or overworked — it is simply on a square the opponent attacks and you do not defend.',
  'allowed-fork':
    'You move without checking which squares an enemy knight or pawn can reach next. The fork is never a surprise to the engine; it is one move deep.',
  'missed-fork':
    'You spot forks when they are played against you but not when they are available to you. You are defending better than you are attacking.',
  'back-rank':
    'Your king sits behind an untouched pawn shield with the heavy pieces still on. Every tactic here ends on your first rank.',
  'allowed-mate':
    'These come from moves made without a king-safety check. By the time the mate appears there was nothing to calculate.',
  'missed-mate':
    'You reach winning positions and stop calculating. The win is there and forcing, and you play a natural move instead.',
  'losing-exchange':
    'You are counting material before the sequence rather than after it.',
  'bad-trade':
    'You trade on general principle rather than on the position. The pieces coming off are your good ones.',
  'trade-into-worse-endgame':
    'You simplify when you are worse because it feels safer. It converts a position you might hold into one that is lost by technique.',
  'allowed-pin':
    'You put pieces on the same line as something more valuable without checking what can attack that line.',
  'missed-capture':
    'Material was hanging and you played a developing move. This is a first-scan problem, not a calculation problem.',
  'king-safety':
    'Your king is the real target in these games and you are treating the position as if it were quiet.',
  'loose-pawn-push':
    'You push pawns near your own king to gain space or chase a piece, and hand over the squares behind them.',
  'missed-check-tactic':
    'You choose a quiet move without first enumerating the checks and captures available to you.',
  'retreat-under-pressure':
    'When a piece is attacked you move it rather than looking for the defence, the counter-attack, or the in-between move.',
};

const SUGGESTIONS: Record<string, string> = {
  'hung-piece':
    'Before each move, name every one of your pieces the opponent can capture. Two minutes of "what is loose?" per game removes most of these.',
  'allowed-fork':
    'Drill knight-fork patterns from the defending side. When an enemy knight can reach a square touching two of your pieces, treat it as a check.',
  'missed-fork':
    'Tactics sets filtered to forks, played from your own colour — you are finding them as the defender but not as the attacker.',
  'back-rank':
    'Make luft a habit once the queens and both rooks are still on. Add back-rank mate puzzles until the pattern fires automatically.',
  'allowed-mate':
    'These are almost always king-safety moves made without a check-capture-threat scan. Slow down whenever your king has fewer than two escape squares.',
  'missed-mate':
    'Mate-in-two and mate-in-three sets. You reach winning positions and then stop calculating forcing lines.',
  'losing-exchange':
    'Exchange-sacrifice and material-count exercises. Count attackers and defenders before initiating, not after.',
  'bad-trade':
    'Study when trades help: trade when ahead in material, avoid trades when your pieces are more active than your opponent’s.',
  'trade-into-worse-endgame':
    'Rook-and-pawn endgame fundamentals, especially Philidor and Lucena. You are simplifying into endings you have not studied.',
  'allowed-pin':
    'Pin and skewer defence: before moving a piece onto a rank, file or diagonal, check what sits behind it.',
  'missed-capture':
    'Slow down on your first scan. A free piece was on the board and you played a developing move instead.',
  'king-safety':
    'Study attacking patterns against your own castled structure so you recognise them one move before they land.',
  'loose-pawn-push':
    'Prophylaxis: ask what the pawn move weakens before you play it. Your king is usually the one paying for it.',
  'missed-check-tactic':
    'Forcing-move discipline: enumerate every check and capture before choosing a quiet move.',
  'retreat-under-pressure':
    'Calculate the defence before assuming retreat is safe. Retreating often loses the tempo that made the position holdable.',
};

/**
 * Clusters the player's mistakes by motif. Each motif is already a claim about
 * mechanism, so grouping on it gives patterns a coach could actually name, rather
 * than "you blunder in the middlegame".
 */
export function detectPatterns(
  db: DB,
  playerId: number,
  lens: Lens,
  options: { minOccurrences?: number; limit?: number } = {},
): Pattern[] {
  const minOccurrences = options.minOccurrences ?? 3;
  const narrowing = lensClause(lens);

  const rows = db
    .prepare(
      `SELECT
         m.game_id, m.ply, m.move_number, m.san, m.uci, m.best_move_san, m.best_move_uci,
         m.fen_before, m.classification, m.win_percent_loss, m.phase, m.motifs, m.clock_after,
         g.time_class, g.opponent, g.end_time, g.eco, g.eco_name, g.player_color
       FROM moves m
       JOIN games g ON g.id = m.game_id
      WHERE g.player_id = @player
        AND m.is_player = 1
        AND g.analysed_at IS NOT NULL
        AND m.motifs <> ''
        AND m.classification IN ('inaccuracy','mistake','blunder')${narrowing}
      ORDER BY m.win_percent_loss DESC`,
    )
    .all(lensParams(playerId, lens)) as MistakeRow[];

  const groups = new Map<string, MistakeRow[]>();
  for (const row of rows) {
    // A move can exhibit several motifs; it belongs to each pattern it evidences.
    for (const motif of row.motifs.split(',').filter(Boolean)) {
      const bucket = groups.get(motif) ?? [];
      bucket.push(row);
      groups.set(motif, bucket);
    }
  }

  const patterns: Pattern[] = [];
  for (const [motif, occurrences] of groups) {
    if (occurrences.length < minOccurrences) continue;
    patterns.push(buildPattern(motif, occurrences));
  }

  patterns.sort((a, b) => b.eloCost - a.eloCost);
  return patterns.slice(0, options.limit ?? 12);
}

function buildPattern(motif: string, rows: MistakeRow[]): Pattern {
  const pointsLost = rows.reduce((sum, r) => sum + r.win_percent_loss / 100, 0);
  const phaseCounts = countBy(rows, (r) => r.phase);
  const [dominantPhase, dominantCount] = topEntry(phaseCounts) ?? ['middlegame', 0];

  const timeClasses = [...new Set(rows.map((r) => r.time_class))].sort(
    (a, b) => countOf(rows, b) - countOf(rows, a),
  );

  const withClock = rows.filter((r) => r.clock_after !== null).map((r) => r.clock_after!);
  const scrambles = withClock.filter((seconds) => seconds < 20).length;

  const ecoCounts = countBy(
    rows.filter((r) => r.eco),
    (r) => `${r.eco} ${r.eco_name ?? 'Unknown opening'}`,
  );
  const topEco = topEntry(ecoCounts);

  const blunders = rows.filter((r) => r.classification === 'blunder').length;
  const mistakes = rows.filter((r) => r.classification === 'mistake').length;
  const inaccuracies = rows.filter((r) => r.classification === 'inaccuracy').length;

  return {
    key: motif,
    motif,
    title: MOTIF_LABELS[motif] ?? motif,
    glyph: blunders >= mistakes && blunders >= inaccuracies ? '??' : mistakes >= inaccuracies ? '?' : '?!',
    occurrences: rows.length,
    gamesAffected: new Set(rows.map((r) => r.game_id)).size,
    blunders,
    mistakes,
    inaccuracies,
    phase: dominantPhase as Phase,
    phaseShare: Math.round((dominantCount / rows.length) * 100),
    timeClasses,
    pointsLost: round1(pointsLost),
    eloCost: Math.round(pointsLost * ELO_K),
    averageWinPercentLoss: round1(
      rows.reduce((sum, r) => sum + r.win_percent_loss, 0) / rows.length,
    ),
    medianSecondsLeft: withClock.length > 0 ? median(withClock) : null,
    timeScrambleShare:
      withClock.length > 0 ? Math.round((scrambles / withClock.length) * 100) : null,
    topOpening: topEco
      ? {
          eco: topEco[0].split(' ')[0]!,
          name: topEco[0].split(' ')[1]!,
          count: topEco[1],
        }
      : null,
    mechanism:
      MECHANISMS[motif] ?? 'These positions share a trigger worth finding — compare them side by side.',
    suggestion:
      SUGGESTIONS[motif] ?? 'Review these positions side by side and look for the common trigger.',
    examples: rows.slice(0, 6).map(toExample),
  };
}

function toExample(row: MistakeRow): PatternExample {
  return {
    gameId: row.game_id,
    ply: row.ply,
    moveNumber: row.move_number,
    san: row.san,
    bestMoveSan: row.best_move_san,
    fenBefore: row.fen_before,
    uci: row.uci,
    bestMoveUci: row.best_move_uci,
    opponent: row.opponent,
    timeClass: row.time_class,
    endTime: row.end_time,
    winPercentLoss: row.win_percent_loss,
    clockAfter: row.clock_after,
    eco: row.eco,
    ecoName: row.eco_name,
    playerColor: row.player_color,
  };
}

function countBy<T>(items: T[], key: (item: T) => string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const item of items) {
    const k = key(item);
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  return counts;
}

function topEntry(counts: Map<string, number>): [string, number] | null {
  let best: [string, number] | null = null;
  for (const entry of counts) {
    if (!best || entry[1] > best[1]) best = entry;
  }
  return best;
}

function countOf(rows: MistakeRow[], timeClass: TimeClass): number {
  return rows.filter((r) => r.time_class === timeClass).length;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? round1(sorted[mid]!)
    : round1((sorted[mid - 1]! + sorted[mid]!) / 2);
}
