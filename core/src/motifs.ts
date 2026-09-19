import { Chess, type Color as ChessColor, type Move, type PieceSymbol, type Square } from 'chess.js';
import { PIECE_VALUE } from './evaluation.js';

/**
 * Motifs are the vocabulary the pattern layer clusters on. Each one is a claim
 * about *why* a move lost value, derived from the board and the engine's
 * refutation rather than from the size of the eval drop alone.
 */
export const MOTIF_LABELS: Record<string, string> = {
  'hung-piece': 'Left a piece hanging',
  'allowed-fork': 'Allowed a fork',
  'missed-fork': 'Missed a fork',
  'back-rank': 'Back-rank weakness',
  'allowed-mate': 'Allowed forced mate',
  'missed-mate': 'Missed forced mate',
  'losing-exchange': 'Lost the exchange',
  'bad-trade': 'Traded into a worse position',
  'trade-into-worse-endgame': 'Traded into a losing endgame',
  'allowed-pin': 'Walked into a pin or skewer',
  'missed-capture': 'Missed free material',
  'king-safety': 'Exposed the king',
  'loose-pawn-push': 'Loosening pawn push',
  'missed-check-tactic': 'Missed a forcing check',
  'retreat-under-pressure': 'Retreated instead of defending',
};

export interface MotifInput {
  fenBefore: string;
  fenAfter: string;
  playedUci: string;
  /** Engine PV from the position before the move (what should have been played). */
  pvBefore: string[];
  /** Engine PV from the position after the move (the refutation). */
  pvAfter: string[];
  mateBefore: number | null;
  mateAfter: number | null;
  /** Drop in winning chances caused by the move. */
  winPercentLoss: number;
  /** A move with no alternative carries no lesson, whatever it cost. */
  forced?: boolean;
}

const HEAVY = new Set<PieceSymbol>(['q', 'r']);
const SLIDERS = new Set<PieceSymbol>(['q', 'r', 'b']);

export function detectMotifs(input: MotifInput): string[] {
  const motifs = new Set<string>();
  if (input.forced) return [];

  // Only mistakes are worth explaining; a good move needs no motive.
  if (input.winPercentLoss < 7) {
    detectMissedWins(input, motifs);
    return [...motifs];
  }

  const before = safeChess(input.fenBefore);
  const after = safeChess(input.fenAfter);
  if (!before || !after) return [...motifs];

  const played = findPlayedMove(before, input.playedUci);
  if (!played) return [...motifs];

  const mover = played.color;
  const opponent: ChessColor = mover === 'w' ? 'b' : 'w';
  const refutation = input.pvAfter[0] ? applyUci(after, input.pvAfter[0]) : null;

  detectMissedWins(input, motifs);

  // Evals are from the mover's point of view, so a mate against them is negative.
  if (input.mateAfter !== null && input.mateAfter < 0) motifs.add('allowed-mate');

  if (hangsMaterial(after, mover, opponent, played, refutation)) motifs.add('hung-piece');

  if (refutation && createsFork(after, refutation, opponent)) motifs.add('allowed-fork');

  if (refutation && isBackRankThreat(after, refutation, mover)) motifs.add('back-rank');

  if (refutation && createsPin(after, refutation, opponent)) motifs.add('allowed-pin');

  if (played.isCapture() && losesMaterialOnTrade(before, after, played, mover)) {
    motifs.add(isEndgamey(input.fenAfter) ? 'trade-into-worse-endgame' : 'bad-trade');
  }

  if (played.piece === 'p' && loosensKing(before, played, mover)) motifs.add('loose-pawn-push');

  if (exposesKing(after, mover, input.pvAfter)) motifs.add('king-safety');

  if (
    played.piece !== 'p' &&
    played.piece !== 'k' &&
    !played.isCapture() &&
    isRetreat(played, mover) &&
    input.winPercentLoss >= 15
  ) {
    motifs.add('retreat-under-pressure');
  }

  return [...motifs];
}

function detectMissedWins(input: MotifInput, motifs: Set<string>): void {
  const bestUci = input.pvBefore[0];
  if (!bestUci || bestUci === input.playedUci) return;

  const stillMating = input.mateAfter !== null && input.mateAfter > 0;
  if (input.mateBefore !== null && input.mateBefore > 0 && !stillMating) {
    motifs.add('missed-mate');
  }

  if (input.winPercentLoss < 10) return;

  const before = safeChess(input.fenBefore);
  if (!before) return;
  const best = findPlayedMove(before, bestUci);
  if (!best) return;

  if (best.isCapture() && !isDefended(before, best.to, best.color === 'w' ? 'b' : 'w')) {
    motifs.add('missed-capture');
  }

  const afterBest = safeChess(before.fen());
  if (afterBest) {
    const applied = applyUci(afterBest, bestUci);
    if (applied) {
      if (afterBest.isCheck()) motifs.add('missed-check-tactic');
      if (createsFork(afterBest, applied, best.color)) motifs.add('missed-fork');
    }
  }
}

/** A piece of the mover's is left where the opponent simply wins it. */
function hangsMaterial(
  after: Chess,
  mover: ChessColor,
  _opponent: ChessColor,
  played: Move,
  refutation: Move | null,
): boolean {
  if (!refutation || !refutation.captured) return false;
  const victimValue = PIECE_VALUE[refutation.captured] ?? 0;
  if (victimValue < 3) return false;

  // A move that just took something of comparable value is a trade, not a hang.
  const justCaptured = played.captured ? (PIECE_VALUE[played.captured] ?? 0) : 0;
  if (justCaptured >= victimValue) return false;

  const attackerValue = PIECE_VALUE[refutation.piece] ?? 0;
  const defenders = after.attackers(refutation.to, mover).length;
  if (defenders === 0) return true;
  return attackerValue < victimValue;
}

/** The refuting move attacks two or more pieces worth taking. */
function createsFork(position: Chess, move: Move, by: ChessColor): boolean {
  const victim: ChessColor = by === 'w' ? 'b' : 'w';
  const targets = squaresAttackedFrom(position, move.to, move.piece, by).filter((square) => {
    const piece = position.get(square);
    if (!piece || piece.color !== victim) return false;
    if (piece.type === 'k') return true;
    const value = PIECE_VALUE[piece.type] ?? 0;
    if (value < 3) return false;
    // Only counts if taking it actually wins material.
    return value > (PIECE_VALUE[move.piece] ?? 0) || position.attackers(square, victim).length === 0;
  });
  return targets.length >= 2;
}

/** A heavy piece landing on the mover's back rank against a boxed-in king. */
function isBackRankThreat(after: Chess, refutation: Move, mover: ChessColor): boolean {
  if (!HEAVY.has(refutation.piece)) return false;
  const backRank = mover === 'w' ? '1' : '8';
  if (!refutation.to.endsWith(backRank)) return false;

  const kingSquare = after.findPiece({ type: 'k', color: mover })[0];
  if (!kingSquare || !kingSquare.endsWith(backRank)) return false;

  const file = kingSquare[0]!;
  const escapeRank = mover === 'w' ? '2' : '7';
  const shelter = [-1, 0, 1]
    .map((offset) => String.fromCharCode(file.charCodeAt(0) + offset))
    .filter((f) => f >= 'a' && f <= 'h')
    .map((f) => after.get(`${f}${escapeRank}` as Square));

  return shelter.filter((piece) => piece?.color === mover && piece.type === 'p').length >= 2;
}

/** The refuting slider lines up on two of the mover's pieces at once. */
function createsPin(after: Chess, refutation: Move, by: ChessColor): boolean {
  if (!SLIDERS.has(refutation.piece)) return false;
  const victim: ChessColor = by === 'w' ? 'b' : 'w';
  const [fileChar, rankChar] = [refutation.to[0]!, refutation.to[1]!];
  const originFile = fileChar.charCodeAt(0) - 97;
  const originRank = Number(rankChar) - 1;

  const directions = directionsFor(refutation.piece);
  for (const [df, dr] of directions) {
    const found: Array<{ type: PieceSymbol }> = [];
    for (let step = 1; step < 8; step += 1) {
      const f = originFile + df * step;
      const r = originRank + dr * step;
      if (f < 0 || f > 7 || r < 0 || r > 7) break;
      const square = `${String.fromCharCode(97 + f)}${r + 1}` as Square;
      const piece = after.get(square);
      if (!piece) continue;
      if (piece.color !== victim) break;
      found.push({ type: piece.type });
      if (found.length === 2) break;
    }
    if (found.length === 2) {
      const front = PIECE_VALUE[found[0]!.type] ?? 0;
      const back = PIECE_VALUE[found[1]!.type] ?? 0;
      if (found[1]!.type === 'k' || back > front) return true;
    }
  }
  return false;
}

function losesMaterialOnTrade(
  _before: Chess,
  after: Chess,
  played: Move,
  mover: ChessColor,
): boolean {
  const gained = played.captured ? (PIECE_VALUE[played.captured] ?? 0) : 0;
  const opponent: ChessColor = mover === 'w' ? 'b' : 'w';
  const recapturers = after.attackers(played.to, opponent);
  if (recapturers.length === 0) return false;
  const cheapestRecapture = Math.min(
    ...recapturers.map((square) => PIECE_VALUE[after.get(square)?.type ?? 'p'] ?? 1),
  );
  const risked = PIECE_VALUE[played.piece] ?? 0;
  const defended = after.attackers(played.to, mover).length > 0;
  const net = defended ? gained - risked + cheapestRecapture : gained - risked;
  return net < 0;
}

function isEndgamey(fen: string): boolean {
  const placement = fen.split(' ')[0] ?? '';
  let pieces = 0;
  for (const char of placement) {
    const lower = char.toLowerCase();
    if (lower === 'n' || lower === 'b' || lower === 'r' || lower === 'q') pieces += 1;
  }
  return pieces <= 8;
}

/** A pawn move in front of the mover's own castled king. */
function loosensKing(before: Chess, played: Move, mover: ChessColor): boolean {
  const kingSquare = before.findPiece({ type: 'k', color: mover })[0];
  if (!kingSquare) return false;
  const kingFile = kingSquare.charCodeAt(0) - 97;
  const pawnFile = played.from.charCodeAt(0) - 97;
  if (Math.abs(kingFile - pawnFile) > 1) return false;

  const homeRank = mover === 'w' ? 1 : 8;
  const kingRank = Number(kingSquare[1]);
  return Math.abs(kingRank - homeRank) <= 1;
}

/** The refutation line checks the mover repeatedly — the king is the real target. */
function exposesKing(after: Chess, mover: ChessColor, pvAfter: string[]): boolean {
  const board = safeChess(after.fen());
  if (!board) return false;
  let checks = 0;
  for (const uci of pvAfter.slice(0, 4)) {
    if (!applyUci(board, uci)) break;
    if (board.isCheck() && board.turn() === mover) checks += 1;
  }
  return checks >= 2;
}

function isRetreat(played: Move, mover: ChessColor): boolean {
  const fromRank = Number(played.from[1]);
  const toRank = Number(played.to[1]);
  return mover === 'w' ? toRank < fromRank : toRank > fromRank;
}

function isDefended(position: Chess, square: Square, by: ChessColor): boolean {
  return position.attackers(square, by).length > 0;
}

/**
 * Which enemy-occupied squares a piece on `square` hits. chess.js only reports
 * attackers of a square, so the relation is inverted by asking each board square
 * whether our square is among its attackers.
 */
function squaresAttackedFrom(
  position: Chess,
  square: Square,
  _piece: PieceSymbol,
  by: ChessColor,
): Square[] {
  const hits: Square[] = [];
  for (const row of position.board()) {
    for (const cell of row) {
      if (!cell) continue;
      if (cell.color === by) continue;
      if (position.attackers(cell.square, by).includes(square)) hits.push(cell.square);
    }
  }
  return hits;
}

function directionsFor(piece: PieceSymbol): Array<[number, number]> {
  const straight: Array<[number, number]> = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ];
  const diagonal: Array<[number, number]> = [
    [1, 1],
    [1, -1],
    [-1, 1],
    [-1, -1],
  ];
  if (piece === 'r') return straight;
  if (piece === 'b') return diagonal;
  return [...straight, ...diagonal];
}

export function safeChess(fen: string): Chess | null {
  try {
    return new Chess(fen);
  } catch {
    return null;
  }
}

export function applyUci(position: Chess, uci: string): Move | null {
  const from = uci.slice(0, 2) as Square;
  const to = uci.slice(2, 4) as Square;
  const promotion = uci.length > 4 ? (uci[4] as PieceSymbol) : undefined;
  try {
    return position.move({ from, to, promotion });
  } catch {
    return null;
  }
}

function findPlayedMove(position: Chess, uci: string): Move | null {
  const probe = safeChess(position.fen());
  if (!probe) return null;
  return applyUci(probe, uci);
}
