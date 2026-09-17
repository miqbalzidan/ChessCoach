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

export interface Dashboard {
  player: Player;
  scope: Scope;
  headline: Headline;
  timeClasses: TimeClassSummary[];
  trend: TrendPoint[];
  phases: PhaseBreakdown[];
  openings: OpeningRow[];
  clock: { buckets: ClockBucket[]; coverage: number; worstMultiplier: number };
  classifications: Array<{ classification: Classification; count: number }>;
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
