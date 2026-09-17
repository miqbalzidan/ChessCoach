import { useMemo } from 'react';

/**
 * Unicode figurines rather than piece sprites — the pieces are type, which keeps
 * the interface icon-set-free and lets the board scale to any size.
 */
const WHITE_GLYPHS: Record<string, string> = {
  k: '♔',
  q: '♕',
  r: '♖',
  b: '♗',
  n: '♘',
  p: '♙',
};

const BLACK_GLYPHS: Record<string, string> = {
  k: '♚',
  q: '♛',
  r: '♜',
  b: '♝',
  n: '♞',
  p: '♟',
};

const PIECE_NAMES: Record<string, string> = {
  k: 'king',
  q: 'queen',
  r: 'rook',
  b: 'bishop',
  n: 'knight',
  p: 'pawn',
};

interface Square {
  file: number;
  rank: number;
  piece: string;
  isWhite: boolean;
  name: string;
}

export function parseFen(fen: string): Square[] {
  const placement = fen.split(' ')[0] ?? '';
  const squares: Square[] = [];
  let rank = 0;
  let file = 0;

  for (const char of placement) {
    if (char === '/') {
      rank += 1;
      file = 0;
      continue;
    }
    if (char >= '1' && char <= '8') {
      file += Number(char);
      continue;
    }
    const isWhite = char === char.toUpperCase();
    const type = char.toLowerCase();
    squares.push({
      file,
      rank,
      piece: type,
      isWhite,
      name: `${String.fromCharCode(97 + file)}${8 - rank}`,
    });
    file += 1;
  }

  return squares;
}

function squareToPercent(square: string, flipped: boolean): { left: string; top: string } | null {
  if (square.length < 2) return null;
  const file = square.charCodeAt(0) - 97;
  const rank = Number(square[1]);
  if (file < 0 || file > 7 || !Number.isFinite(rank) || rank < 1 || rank > 8) return null;
  const x = flipped ? 7 - file : file;
  const y = flipped ? rank - 1 : 8 - rank;
  return { left: `${x * 12.5}%`, top: `${y * 12.5}%` };
}

export interface BoardProps {
  fen: string;
  /** The move played, in UCI — shown as a ringed origin and a filled destination. */
  move?: string | null;
  /** The engine's move, shown in green when it differs from the one played. */
  bestMove?: string | null;
  flipped?: boolean;
  caption?: string;
  /** Rendered bottom-right; used for the eval readout in the review screen. */
  children?: React.ReactNode;
}

export function Board({ fen, move, bestMove, flipped = false, caption, children }: BoardProps) {
  const squares = useMemo(() => parseFen(fen), [fen]);

  const played = move
    ? { from: squareToPercent(move.slice(0, 2), flipped), to: squareToPercent(move.slice(2, 4), flipped) }
    : null;
  const best =
    bestMove && bestMove !== move
      ? {
          from: squareToPercent(bestMove.slice(0, 2), flipped),
          to: squareToPercent(bestMove.slice(2, 4), flipped),
        }
      : null;

  return (
    <div className="board-wrap" role="img" aria-label={describe(squares)}>
      {best?.from && <div className="board-square square-best-from" style={best.from} />}
      {best?.to && <div className="board-square square-best-to" style={best.to} />}
      {played?.from && <div className="board-square square-from" style={played.from} />}
      {played?.to && <div className="board-square square-to" style={played.to} />}

      {squares.map((square) => {
        const position = squareToPercent(square.name, flipped);
        if (!position) return null;
        const glyph = square.isWhite ? WHITE_GLYPHS[square.piece] : BLACK_GLYPHS[square.piece];
        return (
          <span
            key={square.name}
            className={square.isWhite ? 'piece piece-white' : 'piece'}
            style={position}
            aria-hidden="true"
          >
            {glyph}
          </span>
        );
      })}

      {caption && <div className="board-caption">{caption}</div>}
      {children}
    </div>
  );
}

function describe(squares: Square[]): string {
  const white = squares.filter((s) => s.isWhite).length;
  const black = squares.length - white;
  const kings = squares.filter((s) => s.piece === 'k').length;
  return `Chess position, ${white} white and ${black} black pieces${kings === 2 ? '' : ''}. ${squares
    .slice(0, 4)
    .map((s) => `${PIECE_NAMES[s.piece]} on ${s.name}`)
    .join(', ')}`;
}
