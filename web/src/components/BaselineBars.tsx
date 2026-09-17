import type { TrendPoint } from '../types';
import { formatDate } from '../format';

const MAX_HEIGHT = 46;

/**
 * Games hang above or below a single ink rule instead of sitting in a chart box,
 * so "that was a blunder game" is a spatial fact you read at a glance rather than
 * something you hover to discover.
 */
export function BaselineBars({
  trend,
  selectedGameId,
  onSelect,
  height = 104,
}: {
  trend: TrendPoint[];
  selectedGameId?: number | null;
  onSelect?: (point: TrendPoint) => void;
  height?: number;
}) {
  const mid = height / 2;

  return (
    <div className="baseline" style={{ height }}>
      <div className="baseline-rule" />
      <div className="baseline-bars">
        {trend.map((point) => {
          const hasBlunder = point.blunders > 0;
          const magnitude = hasBlunder
            ? Math.min(1, point.blunders / 3)
            : Math.max(0, Math.min(1, (point.accuracy - 50) / 45));
          const barHeight = Math.max(7, Math.round(magnitude * (MAX_HEIGHT * (height / 104))));

          const style = hasBlunder
            ? { top: mid, height: barHeight, background: 'var(--vermilion)' }
            : { bottom: mid, height: barHeight, background: 'rgba(20,19,15,.62)' };

          return (
            <button
              key={point.gameId}
              type="button"
              className={`baseline-bar${selectedGameId === point.gameId ? ' is-selected' : ''}`}
              onClick={() => onSelect?.(point)}
              title={`${formatDate(point.endTime)} vs ${point.opponent} — ${point.accuracy?.toFixed(1) ?? '—'}% accuracy, ${point.blunders} blunders (${point.result})`}
              aria-label={`${formatDate(point.endTime)} versus ${point.opponent}, ${point.accuracy?.toFixed(1) ?? 'unknown'} percent accuracy, ${point.blunders} blunders, ${point.result}`}
            >
              <span style={style} />
            </button>
          );
        })}
      </div>
    </div>
  );
}
