import type { GameReview, Move } from '../types';
import { formatDate } from '../format';

/**
 * Claude's reading of the game, between the graph and the board.
 *
 * The graph shows where the game turned; this says why. Each turning point is a
 * button onto the board, so the reading is walked through the same way the moves
 * are, and the full explanation for a turning point appears beside the board when
 * you land on it rather than all at once up here.
 *
 * Asking is always a deliberate act. It spends a run of the player's Claude plan and
 * takes most of a minute, so nothing here fires on its own.
 */
export function GameReading({
  review,
  moves,
  ply,
  onSelect,
  canAsk,
  asking,
  error,
  onAsk,
}: {
  review: GameReview | null;
  moves: Move[];
  ply: number;
  onSelect: (ply: number) => void;
  /** False wherever Claude Code cannot be reached: a snapshot, or the phone on its own. */
  canAsk: boolean;
  asking: boolean;
  error: string | null;
  onAsk: () => void;
}) {
  // Nothing to show and nothing to offer: a read-only copy of a game nobody asked
  // Claude about. Saying so would only be noise.
  if (!review && !canAsk) return null;

  return (
    <section className="reading" aria-live="polite">
      <div className="reading-head">
        <span className="label-sm">claude’s reading</span>
        {review ? (
          <span className="reading-by">
            {review.model} · {formatDate(review.generatedAt)}
            {review.stale ? ' · written before this game was re-analysed' : ''}
          </span>
        ) : null}
        {canAsk ? (
          <button
            type="button"
            className="btn btn-ghost btn-sm reading-ask"
            onClick={onAsk}
            disabled={asking}
          >
            {asking ? 'Claude is reading…' : review ? 'read it again' : 'ask Claude about this game'}
          </button>
        ) : null}
      </div>

      {error ? <div className="reading-error">{error}</div> : null}

      {!review && !asking && !error ? (
        <p className="reading-note">
          Stockfish has scored every move. Claude reads that analysis and tells you which
          moments decided the game and why — through Claude Code on this computer, on
          your Claude plan.
        </p>
      ) : null}

      {asking && !review ? (
        <p className="reading-note">
          Reading {moves.length} moves and the engine’s verdicts on them. This usually takes
          under a minute.
        </p>
      ) : null}

      {review ? (
        <>
          <p className="reading-summary coach-prose">{review.summary}</p>

          {review.turningPoints.length > 0 ? (
            <ol className="reading-points">
              {review.turningPoints.map((point) => {
                const move = moves[point.ply - 1];
                return (
                  <li key={point.ply}>
                    <button
                      type="button"
                      className={`reading-point${point.ply === ply ? ' is-current' : ''}`}
                      onClick={() => onSelect(point.ply)}
                      aria-pressed={point.ply === ply}
                    >
                      <span className="reading-move">
                        {move ? `${move.move_number}${move.color === 'white' ? '.' : '…'} ${move.san}` : `ply ${point.ply}`}
                      </span>
                      <span className="reading-title">{withoutMove(point.title, move?.san)}</span>
                    </button>
                  </li>
                );
              })}
            </ol>
          ) : null}

          <p className="reading-lesson">
            <span className="label-sm">into the next game</span>
            <span className="coach-prose">{review.lesson}</span>
          </p>
          {review.recurring ? <p className="reading-recurring">{review.recurring}</p> : null}
        </>
      ) : null}
    </section>
  );
}

/**
 * The title, minus the move it opens with.
 *
 * The chip already prints the move, and Claude tends to start its title with it
 * anyway — "Kh2 instead of Ng5" beside "8. Kh2" — so the repeat is taken off here,
 * where both halves are in view. A title that is nothing but the move is left alone.
 */
export function withoutMove(title: string, san: string | undefined): string {
  if (!san) return title;
  const escaped = san.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const trimmed = title.replace(new RegExp(`^(\\d+\\s*\\.{1,3}\\s*|\\d+…\\s*)?${escaped}(?![\\w])[\\s:—–-]*`), '');
  return trimmed.length > 0 ? trimmed : title;
}
