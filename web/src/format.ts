import type { Classification, Scope } from './types';

export function formatEval(cp: number, mate: number | null): string {
  if (mate !== null) return mate > 0 ? `M${mate}` : `-M${Math.abs(mate)}`;
  if (Math.abs(cp) >= 9000) return cp > 0 ? 'M' : '-M';
  const pawns = cp / 100;
  return `${pawns > 0 ? '+' : ''}${pawns.toFixed(1)}`;
}

export function formatClock(seconds: number | null): string {
  if (seconds === null) return '—';
  if (seconds >= 3600) {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    return `${hours}h${String(minutes).padStart(2, '0')}`;
  }
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  if (minutes === 0) return `${rest.toFixed(1)}s`;
  return `${minutes}:${rest.toFixed(0).padStart(2, '0')}`;
}

export function formatDate(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
  });
}

export function formatDateTime(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toLocaleString(undefined, {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function relativeTime(unixSeconds: number | null): string {
  if (!unixSeconds) return 'never';
  const delta = Math.floor(Date.now() / 1000) - unixSeconds;
  if (delta < 60) return 'just now';
  if (delta < 3600) return `${Math.floor(delta / 60)} min ago`;
  if (delta < 86400) return `${Math.floor(delta / 3600)}h ago`;
  return `${Math.floor(delta / 86400)}d ago`;
}

export function signed(value: number, digits = 1): string {
  const fixed = value.toFixed(digits);
  return value > 0 ? `+${fixed}` : fixed;
}

export function glyphClass(classification: Classification): string {
  if (classification === 'blunder') return 'glyph-blunder';
  if (classification === 'mistake') return 'glyph-mistake';
  if (classification === 'inaccuracy') return 'glyph-inaccuracy';
  if (classification === 'brilliant') return 'glyph-brilliant';
  return '';
}

export function scopeLabel(scope: Scope): string {
  return scope === 'all' ? 'all time controls' : scope;
}

/** Turns the internal spelling of a time control into the one Chess.com shows. */
export function timeControlLabel(timeControl: string): string {
  if (timeControl.includes('/')) {
    const days = Number(timeControl.split('/')[1]) / 86400;
    return Number.isFinite(days) ? `${days}-day` : timeControl;
  }
  const [base, increment] = timeControl.split('+');
  const minutes = Number(base) / 60;
  if (!Number.isFinite(minutes)) return timeControl;
  const shown =
    minutes >= 1 ? `${Number.isInteger(minutes) ? minutes : minutes.toFixed(1)}` : `${base}s`;
  if (increment && Number(increment) > 0) return `${shown}+${increment}`;
  return minutes >= 1 ? `${shown} min` : shown;
}

export function pluralise(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}
