export type TimeClass = 'bullet' | 'blitz' | 'rapid' | 'daily';

export const TIME_CLASSES: TimeClass[] = ['bullet', 'blitz', 'rapid', 'daily'];

export type Scope = TimeClass | 'all';

/* ---------- the lens ----------
   What the whole sheet is narrowed to. Time class was the only lens for a long
   while; an opening is a second one, and the two compose — "the Berlin as Black,
   in blitz" is a question the stored analysis can already answer.

   Everything downstream takes a Lens rather than a Scope, so a report cannot be
   computed for one narrowing and labelled with another. */

export interface Lens {
  scope: Scope;
  /** ECO code, e.g. C65. Absent means every opening. */
  eco?: string | null;
  /** Which side the player had. Absent means both. */
  color?: 'white' | 'black' | null;
}

/**
 * One stable string per lens — the coaching cache key, the snapshot key, and the
 * effect dependency on the client. An unfiltered lens keys as its bare scope, so
 * `all` and `blitz` mean exactly what they always did.
 */
export function lensKey(lens: Lens): string {
  if (!lens.eco) return lens.scope;
  return lens.color ? `${lens.scope}:${lens.eco}:${lens.color}` : `${lens.scope}:${lens.eco}`;
}

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
