import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

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

/** Board coordinates in eighths, with the orientation already applied. */
function squareToCell(square: string, flipped: boolean): { x: number; y: number } | null {
  if (square.length < 2) return null;
  const file = square.charCodeAt(0) - 97;
  const rank = Number(square[1]);
  if (file < 0 || file > 7 || !Number.isFinite(rank) || rank < 1 || rank > 8) return null;
  return { x: flipped ? 7 - file : file, y: flipped ? rank - 1 : 8 - rank };
}

function squareToPercent(square: string, flipped: boolean): { left: string; top: string } | null {
  const cell = squareToCell(square, flipped);
  return cell ? { left: `${cell.x * 12.5}%`, top: `${cell.y * 12.5}%` } : null;
}

function cellToSquare(x: number, y: number, flipped: boolean): string {
  const file = flipped ? 7 - x : x;
  const rank = flipped ? y + 1 : 8 - y;
  return `${String.fromCharCode(97 + file)}${rank}`;
}

/** The dark squares only. They never touch each other, so no seam can show between
 *  them — which is the whole reason the checkerboard is not a repeating gradient:
 *  a gradient's stops land on fractional pixels and saw along every diagonal. */
const DARK_CELLS: Array<{ x: number; y: number }> = [];
for (let y = 0; y < 8; y += 1) {
  for (let x = 0; x < 8; x += 1) {
    if ((x + y) % 2 === 1) DARK_CELLS.push({ x, y });
  }
}

interface Slide {
  square: string;
  dx: number;
  dy: number;
}

/**
 * Works out what slid where, so the move can be animated. Rather than track piece
 * identity across positions, the piece is drawn at its destination and a keyframe
 * animation runs it in from where it came. Nothing has to be matched between
 * positions, and because the browser owns the animation there is no second render
 * to schedule and nothing to get out of step with.
 */
function slidesFor(move: string | null | undefined, squares: Square[], flipped: boolean): Slide[] {
  if (!move || move.length < 4) return [];
  const from = move.slice(0, 2);
  const to = move.slice(2, 4);
  const start = squareToCell(from, flipped);
  const end = squareToCell(to, flipped);
  if (!start || !end) return [];

  const slides: Slide[] = [{ square: to, dx: start.x - end.x, dy: start.y - end.y }];

  // Castling moves two pieces; the rook should travel with the king rather than
  // appear on its new square out of nowhere.
  const moved = squares.find((square) => square.name === to);
  const fileDelta = Math.abs(to.charCodeAt(0) - from.charCodeAt(0));
  if (moved?.piece === 'k' && fileDelta === 2) {
    const rank = to[1] ?? '1';
    const kingside = to[0] === 'g';
    const rookFrom = `${kingside ? 'h' : 'a'}${rank}`;
    const rookTo = `${kingside ? 'f' : 'd'}${rank}`;
    const rookStart = squareToCell(rookFrom, flipped);
    const rookEnd = squareToCell(rookTo, flipped);
    if (rookStart && rookEnd) {
      slides.push({ square: rookTo, dx: rookStart.x - rookEnd.x, dy: rookStart.y - rookEnd.y });
    }
  }

  return slides;
}

interface Arrow {
  from: string;
  to: string;
}

export interface BoardProps {
  fen: string;
  /** The move played, in UCI — shown as a ringed origin and a filled destination. */
  move?: string | null;
  /** The engine's move, shown in green when it differs from the one played. */
  bestMove?: string | null;
  flipped?: boolean;
  caption?: string;
  /** Right-click to highlight a square, right-drag to draw an arrow. Review only —
   *  the pattern thumbnails are not somewhere you stop to think. */
  markable?: boolean;
  /** Slide pieces into place when the position changes. */
  animate?: boolean;
  /** Rendered bottom-right; used for the eval readout in the review screen. */
  children?: React.ReactNode;
}

export function Board({
  fen,
  move,
  bestMove,
  flipped = false,
  caption,
  markable = false,
  animate = false,
  children,
}: BoardProps) {
  const squares = useMemo(() => parseFen(fen), [fen]);
  const wrapRef = useRef<HTMLDivElement>(null);

  const [marks, setMarks] = useState<string[]>([]);
  const [arrows, setArrows] = useState<Arrow[]>([]);
  const dragFrom = useRef<string | null>(null);

  const slides = useMemo(
    () => (animate ? slidesFor(move, squares, flipped) : []),
    [animate, move, squares, flipped],
  );

  // Your own marks belong to the position you drew them on.
  useEffect(() => {
    setMarks([]);
    setArrows([]);
  }, [fen]);

  const squareAt = useCallback(
    (event: React.MouseEvent): string | null => {
      const box = wrapRef.current?.getBoundingClientRect();
      if (!box || box.width === 0) return null;
      const x = Math.floor(((event.clientX - box.left) / box.width) * 8);
      const y = Math.floor(((event.clientY - box.top) / box.height) * 8);
      if (x < 0 || x > 7 || y < 0 || y > 7) return null;
      return cellToSquare(x, y, flipped);
    },
    [flipped],
  );

  const onMouseDown = useCallback(
    (event: React.MouseEvent) => {
      if (!markable) return;
      if (event.button === 2) {
        dragFrom.current = squareAt(event);
        return;
      }
      // Left click clears the markup, the way every board does.
      if (event.button === 0 && (marks.length > 0 || arrows.length > 0)) {
        setMarks([]);
        setArrows([]);
      }
    },
    [markable, squareAt, marks.length, arrows.length],
  );

  const onMouseUp = useCallback(
    (event: React.MouseEvent) => {
      if (!markable || event.button !== 2) return;
      const from = dragFrom.current;
      dragFrom.current = null;
      const to = squareAt(event);
      if (!from || !to) return;

      if (from === to) {
        setMarks((current) =>
          current.includes(from) ? current.filter((sq) => sq !== from) : [...current, from],
        );
        return;
      }
      setArrows((current) => {
        const existing = current.findIndex((arrow) => arrow.from === from && arrow.to === to);
        if (existing >= 0) return current.filter((_, index) => index !== existing);
        return [...current, { from, to }];
      });
    },
    [markable, squareAt],
  );

  const played = move
    ? {
        from: squareToPercent(move.slice(0, 2), flipped),
        to: squareToPercent(move.slice(2, 4), flipped),
      }
    : null;
  const best =
    bestMove && bestMove !== move
      ? {
          from: squareToPercent(bestMove.slice(0, 2), flipped),
          to: squareToPercent(bestMove.slice(2, 4), flipped),
        }
      : null;

  const slideFor = (square: string): Slide | undefined => slides.find((s) => s.square === square);

  return (
    <div
      ref={wrapRef}
      className="board-wrap"
      role="img"
      aria-label={describe(squares)}
      onMouseDown={onMouseDown}
      onMouseUp={onMouseUp}
      onContextMenu={markable ? (event) => event.preventDefault() : undefined}
    >
      {DARK_CELLS.map((cell) => (
        <div
          key={`${cell.x}-${cell.y}`}
          className="board-dark-square"
          style={{ left: `${cell.x * 12.5}%`, top: `${cell.y * 12.5}%` }}
        />
      ))}

      {best?.from && <div className="board-square square-best-from" style={best.from} />}
      {best?.to && <div className="board-square square-best-to" style={best.to} />}
      {played?.from && <div className="board-square square-from" style={played.from} />}
      {played?.to && <div className="board-square square-to" style={played.to} />}

      {marks.map((square) => {
        const position = squareToPercent(square, flipped);
        return position ? (
          <div key={`mark-${square}`} className="board-square square-marked" style={position} />
        ) : null;
      })}

      {squares.map((square) => {
        const position = squareToPercent(square.name, flipped);
        if (!position) return null;
        const glyph = square.isWhite ? WHITE_GLYPHS[square.piece] : BLACK_GLYPHS[square.piece];
        const slide = slideFor(square.name);
        return (
          <span
            /* The key carries the piece as well as the square: on a capture the
               destination already held a piece, and without this React would reuse
               that element and the arriving piece would not animate. */
            key={`${square.name}-${square.piece}-${square.isWhite ? 'w' : 'b'}`}
            className={`piece${square.isWhite ? ' piece-white' : ''}${slide ? ' is-sliding' : ''}`}
            style={
              {
                ...position,
                ...(slide ? { '--dx': `${slide.dx * 100}%`, '--dy': `${slide.dy * 100}%` } : {}),
              } as React.CSSProperties
            }
            aria-hidden="true"
          >
            {glyph}
          </span>
        );
      })}

      {arrows.length > 0 && (
        <svg className="board-arrows" viewBox="0 0 8 8" aria-hidden="true">
          <defs>
            <marker
              id="board-arrowhead"
              viewBox="0 0 10 10"
              refX="6"
              refY="5"
              markerWidth="3.2"
              markerHeight="3.2"
              orient="auto-start-reverse"
            >
              <path d="M 0 1 L 8 5 L 0 9 z" fill="var(--mark)" />
            </marker>
          </defs>
          {arrows.map((arrow) => {
            const from = squareToCell(arrow.from, flipped);
            const to = squareToCell(arrow.to, flipped);
            if (!from || !to) return null;
            return (
              <line
                key={`${arrow.from}${arrow.to}`}
                x1={from.x + 0.5}
                y1={from.y + 0.5}
                x2={to.x + 0.5}
                y2={to.y + 0.5}
                markerEnd="url(#board-arrowhead)"
              />
            );
          })}
        </svg>
      )}

      {caption && <div className="board-caption">{caption}</div>}
      {children}
    </div>
  );
}

function describe(squares: Square[]): string {
  const white = squares.filter((s) => s.isWhite).length;
  const black = squares.length - white;
  return `Chess position, ${white} white and ${black} black pieces. ${squares
    .slice(0, 4)
    .map((s) => `${PIECE_NAMES[s.piece]} on ${s.name}`)
    .join(', ')}`;
}
