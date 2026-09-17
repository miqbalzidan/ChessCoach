export type TimeClass = 'bullet' | 'blitz' | 'rapid' | 'daily';

export const TIME_CLASSES: TimeClass[] = ['bullet', 'blitz', 'rapid', 'daily'];

export type Color = 'white' | 'black';

export type GameResult = 'win' | 'loss' | 'draw';

export type Phase = 'opening' | 'middlegame' | 'endgame';

/**
 * Chess already has an annotation vocabulary, so the classifications map onto it
 * rather than inventing a parallel set of badge names.
 */
export type Classification =
  | 'brilliant'
  | 'best'
  | 'excellent'
  | 'good'
  | 'inaccuracy'
  | 'mistake'
  | 'blunder';

export const GLYPH: Record<Classification, string> = {
  brilliant: '!!',
  best: '!',
  excellent: '',
  good: '',
  inaccuracy: '?!',
  mistake: '?',
  blunder: '??',
};

/** A Stockfish evaluation from the side-to-move's point of view. */
export interface Score {
  /** Centipawns, present unless the position is a forced mate. */
  cp: number | null;
  /** Moves until mate; positive means the side to move mates. */
  mate: number | null;
}

export interface EngineLine {
  score: Score;
  /** Principal variation in UCI long-algebraic form. */
  pv: string[];
  depth: number;
}

export interface AnalysedMove {
  ply: number;
  moveNumber: number;
  color: Color;
  san: string;
  uci: string;
  /** FEN before the move was played. */
  fenBefore: string;
  fenAfter: string;
  /** Eval before the move, from the mover's point of view, in centipawns. */
  evalBefore: number;
  /** Eval after the move, still from the mover's point of view. */
  evalAfter: number;
  mateBefore: number | null;
  mateAfter: number | null;
  /** Centipawn loss, clamped at zero — a move can never be better than best. */
  centipawnLoss: number;
  /** Drop in win probability (percentage points) caused by this move. */
  winPercentLoss: number;
  /** Per-move accuracy percentage, 0–100. */
  accuracy: number;
  classification: Classification;
  bestMoveUci: string | null;
  bestMoveSan: string | null;
  /** The engine's principal variation from the position before the move. */
  pv: string[];
  phase: Phase;
  /** Seconds left on the mover's clock after playing, when the PGN carries clocks. */
  clockAfter: number | null;
  /** Seconds spent on this move, when derivable. */
  timeSpent: number | null;
  /** Detected tactical motifs for the mistakes worth clustering. */
  motifs: string[];
}

export interface GameAnalysis {
  moves: AnalysedMove[];
  accuracyWhite: number;
  accuracyBlack: number;
  depth: number;
  engine: string;
}

export interface ImportedGame {
  externalId: string;
  source: 'chess.com' | 'pgn';
  url: string | null;
  pgn: string;
  timeClass: TimeClass;
  timeControl: string;
  endTime: number;
  rated: boolean;
  whiteUsername: string;
  blackUsername: string;
  whiteRating: number | null;
  blackRating: number | null;
  whiteResult: string;
  blackResult: string;
  eco: string | null;
  ecoName: string | null;
}
