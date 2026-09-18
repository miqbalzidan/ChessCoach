export type TimeClass = 'bullet' | 'blitz' | 'rapid' | 'daily';
export type Scope = TimeClass | 'all';
export type GameResult = 'win' | 'loss' | 'draw';
export type Phase = 'opening' | 'middlegame' | 'endgame';

export type Classification =
  | 'brilliant'
  | 'best'
  | 'excellent'
  | 'good'
  | 'inaccuracy'
  | 'mistake'
  | 'blunder';

export const TIME_CLASSES: TimeClass[] = ['bullet', 'blitz', 'rapid', 'daily'];

/* ---------- the lens ----------
   Defined in core, because the server, the browser and the analysis all narrow by
   it. Re-exported here so every screen keeps importing it from one place. */

import type { Lens } from '../../core/src/types';

export type { Lens };
export { lensKey } from '../../core/src/types';

/** Chess's own annotation vocabulary is the icon set. */
export const GLYPH: Record<Classification, string> = {
  brilliant: '!!',
  best: '',
  excellent: '',
  good: '',
  inaccuracy: '?!',
  mistake: '?',
  blunder: '??',
};

export interface Player {
  id: number;
  username: string;
  source: string;
  created_at: number;
  last_synced_at: number | null;
}

export interface Game {
  id: number;
  player_id: number;
  external_id: string;
  source: string;
  url: string | null;
  pgn?: string;
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
  player_color: 'white' | 'black';
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
}

export interface Move {
  id: number;
  game_id: number;
  ply: number;
  move_number: number;
  color: 'white' | 'black';
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
  classification: Classification;
  best_move_uci: string | null;
  best_move_san: string | null;
  pv: string | null;
  phase: Phase;
  clock_after: number | null;
  time_spent: number | null;
  motifs: string;
}

export interface Job {
  id: number;
  player_id: number | null;
  username: string;
  status: 'queued' | 'running' | 'done' | 'error';
  stage: 'queued' | 'fetching' | 'importing' | 'analysing' | 'done' | 'error';
  imported: number;
  analysed: number;
  total: number;
  message: string | null;
  created_at: number;
  updated_at: number;
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

export interface TrendPoint {
  gameId: number;
  endTime: number;
  accuracy: number;
  blunders: number;
  mistakes: number;
  result: GameResult;
  opponent: string;
  timeClass: TimeClass;
}

export interface PhaseBreakdown {
  phase: Phase;
  inaccuracies: number;
  mistakes: number;
  blunders: number;
  total: number;
  share: number;
  moves: number;
  rate: number;
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

export interface ClockBucket {
  label: string;
  moves: number;
  blunders: number;
  rate: number;
  multiplier: number;
}

export interface TimeClassSummary {
  timeClass: TimeClass;
  games: number;
  analysed: number;
  accuracy: number;
  blundersPerGame: number;
  winRate: number;
}

export interface AnalysisSource {
  engine: string;
  depth: number;
  games: number;
}

export interface Dashboard {
  player: Player;
  scope: Scope;
  /** The narrowing these numbers were computed under, echoed back so a screen can
   *  never label one lens's figures with another's. */
  lens: Lens;
  headline: Headline;
  timeClasses: TimeClassSummary[];
  trend: TrendPoint[];
  phases: PhaseBreakdown[];
  openings: OpeningRow[];
  clock: { buckets: ClockBucket[]; coverage: number; worstMultiplier: number };
  classifications: Array<{ classification: Classification; count: number }>;
  /** Which engine and depth produced these games. More than one entry means the
   *  figures below mix instruments, which the sheet says rather than hides. */
  sources: AnalysisSource[];
}

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
  phase: Phase;
  phaseShare: number;
  timeClasses: TimeClass[];
  pointsLost: number;
  eloCost: number;
  averageWinPercentLoss: number;
  medianSecondsLeft: number | null;
  timeScrambleShare: number | null;
  topOpening: { eco: string; name: string; count: number } | null;
  mechanism: string;
  suggestion: string;
  examples: PatternExample[];
}

export interface Coaching {
  headline: string;
  diagnosis: string;
  patterns: Array<{ key: string; explanation: string; drill: string }>;
  studyPlan: string[];
  model: string;
  generatedAt: number;
}

export interface Settings {
  analysisDepth: number;
  engine: string;
  engines: number;
  coaching: 'claude' | 'offline';
  players: Player[];
}

export interface Trait {
  key: string;
  title: string;
  detail: string;
  /** The measurement behind the claim, shown beside it. */
  evidence: string;
  weight: number;
}

export interface Profile {
  strengths: Trait[];
  weaknesses: Trait[];
  games: number;
  /** Too few games to say anything responsibly. */
  thin: boolean;
}

/* ---------- snapshot ----------
   A snapshot is the whole leak sheet frozen at a moment: everything the read-only
   screens ask for, already computed. The phone has no engine and no database, so
   anything not in here cannot be shown.

   This type is the contract between the exporter (server/src/export.ts) and the
   client that reads it. Both import it from this file, so a field added on one
   side and forgotten on the other is a compile error rather than a blank panel
   discovered on a phone. */

export const SNAPSHOT_VERSION = 2;

export interface SnapshotScope {
  dashboard: Dashboard;
  patterns: Pattern[];
  /** Motif key → display label, as the patterns endpoint returns it. */
  labels: Record<string, string>;
  /** Null when a scope has no games worth coaching on. */
  coaching: Coaching | null;
  profile: Profile;
}

export interface Snapshot {
  version: number;
  /** Unix seconds — shown in the masthead so a stale sheet is never mistaken for a live one. */
  generatedAt: number;
  engine: string;
  analysisDepth: number;
  /** The minimum-occurrence cut-off the patterns were computed with. */
  minOccurrences: number;
  player: Player;
  games: Game[];
  /** Game id → its moves. Keys are strings because this survives JSON. */
  moves: Record<string, Move[]>;
  /** Lens key → the whole sheet under that lens: the five time classes, plus one
   *  entry per opening the picker can reach. A lens that was never exported cannot
   *  be computed on a phone, so the picker only ever offers what is in here. */
  lenses: Record<string, SnapshotScope>;
  /** Version 1 snapshots, keyed by time class alone. Read on load, never written. */
  scopes?: Record<Scope, SnapshotScope>;
}
