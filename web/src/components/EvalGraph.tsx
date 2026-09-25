import { useMemo } from 'react';
import { formatEval, glyphClass } from '../format';
import { advantageCurve, advantageLine, isMarked, type AdvantagePoint } from '../graph';
import { VERDICT, type Classification, type Move } from '../types';

/** A blunder should be the thing your eye lands on first, so severity sets the size. */
const MARK_SIZE: Partial<Record<Classification, number>> = {
  blunder: 11,
  mistake: 9,
  inaccuracy: 7,
  brilliant: 9,
};

/**
 * The whole game on one line, so "where did it go wrong" is a glance rather than a
 * walk through eighty moves.
 *
 * The two territories are the two sides' own colours — the same ink and bone the
 * pieces are drawn in — so the graph reads as White against Black without a key.
 * What it does not do is put White on top regardless: the line rises as *you* gain,
 * the way the eval strip beside the board fills and the way the board itself is
 * turned. Every other number on this screen is already from your side; a graph that
 * went the other way for half your games would be the one thing here you had to
 * translate before reading.
 *
 * Only your own leaks and brilliancies get a dot. Marking the opponent's too would
 * double the ink and answer a question nobody came here with.
 */
export function EvalGraph({
  moves,
  playerColor,
  ply,
  onSelect,
}: {
  moves: Move[];
  playerColor: 'white' | 'black';
  ply: number;
  onSelect: (ply: number) => void;
}) {
  const points = useMemo(() => advantageLine(moves, playerColor), [moves, playerColor]);

  // One move is not a shape. Nothing to draw, and nothing lost by not drawing it.
  if (points.length < 3) return null;

  const span = points.length - 1;
  const curve = advantageCurve(points);
  // Your share of the board, filled up from the floor: the strip beside the board,
  // unrolled over the length of the game.
  const yours = `0,100 ${curve} ${span},100`;
  const opponentColor = playerColor === 'white' ? 'black' : 'white';
  const at = (index: number) => `${(index / span) * 100}%`;

  return (
    <div className="evalgraph">
      <div className="evalgraph-head">
        <span className="label-sm">the game at a glance</span>
        <span className="evalgraph-legend">
          <span className={`player-disc player-disc-${playerColor}`} aria-hidden="true" />
          you
          <span className="evalgraph-legend-rule" aria-hidden="true" />
          <span className={`player-disc player-disc-${opponentColor}`} aria-hidden="true" />
          them
        </span>
      </div>

      <div className={`evalgraph-plot is-you-${playerColor}`}>
        {/* preserveAspectRatio="none" lets one ply be one unit wide whatever the
            screen is; strokes would stretch with it, so they opt out. */}
        <svg viewBox={`0 0 ${span} 100`} preserveAspectRatio="none" aria-hidden="true">
          <polygon className="evalgraph-area" points={yours} />
          <line
            className="evalgraph-level"
            x1="0"
            y1="50"
            x2={span}
            y2="50"
            vectorEffect="non-scaling-stroke"
          />
          <polyline className="evalgraph-line" points={curve} vectorEffect="non-scaling-stroke" />
        </svg>

        {/* The dots and the cursor sit outside the SVG so they keep their shape: a
            circle in a stretched viewBox comes out an ellipse. */}
        <div className="evalgraph-marks" aria-hidden="true">
          {/* A line rather than a dot on the curve: the screen opens on the first
              blunder, and a dot there would sit on top of the very mark you came
              to look at. */}
          <span className="evalgraph-cursor" style={{ left: at(ply) }} />
          {points.map((point, index) => {
            const move = isMarked(point) ? point.move : null;
            if (!move) return null;
            const size = MARK_SIZE[move.classification] ?? 8;
            return (
              <span
                key={point.ply}
                className={`evalgraph-mark ${glyphClass(move.classification)}`}
                style={{ left: at(index), top: `${100 - point.share}%`, width: size, height: size }}
              />
            );
          })}
        </div>

        {/* One hit area per move, covering the stretch of line that move drew.
            Keyboard users already have ← → and the move list for this, so these stay
            out of the tab order rather than putting eighty stops before the sheet. */}
        <div className="evalgraph-hits">
          {points.slice(1).map((point) => (
            <button
              key={point.ply}
              type="button"
              tabIndex={-1}
              className="evalgraph-hit"
              onClick={() => onSelect(point.ply)}
              title={describe(point)}
              aria-label={describe(point)}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

/** What hovering a move on the line says: the move, the verdict, and where it left you. */
function describe(point: AdvantagePoint): string {
  const move = point.move;
  if (!move) return 'starting position';
  const number = `${move.move_number}${move.color === 'white' ? '.' : '…'}`;
  const verdict = move.is_player === 1 ? ` — ${VERDICT[move.classification]}` : '';
  return `${number} ${move.san}${verdict} · ${formatEval(point.cp, point.mate)} for you`;
}
