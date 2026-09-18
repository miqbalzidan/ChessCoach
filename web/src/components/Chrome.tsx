import { NavLink } from 'react-router-dom';
import type { Lens, OpeningRow, Scope, TimeClassSummary } from '../types';
import { TIME_CLASSES } from '../types';
import { activeSnapshot } from '../snapshot';
import { pluralise, relativeTime } from '../format';

const SECTIONS = [
  { to: '/', label: '01 sheet', end: true },
  { to: '/library', label: '02 library', end: false },
  { to: '/patterns', label: '04 patterns', end: false },
  { to: '/import', label: '05 import', end: false },
  { to: '/settings', label: '06 settings', end: false },
];

export function Masthead({ username }: { username: string | null }) {
  const snapshot = activeSnapshot();
  // Importing needs an engine, so it is not a section of a snapshot.
  const sections = snapshot ? SECTIONS.filter((section) => section.to !== '/import') : SECTIONS;

  return (
    <header className="masthead">
      <div>
        <div className="masthead-title">Leak sheet{username ? ` — ${username}` : ''}</div>
        {snapshot && (
          /* A snapshot is a photograph, and an undated photograph of your chess is
             worse than none — it reads as today's form when it may be a month old. */
          <div className="masthead-provenance">
            snapshot · {pluralise(snapshot.games.length, 'game')} · taken{' '}
            {relativeTime(snapshot.generatedAt)} · {snapshot.engine} depth{' '}
            {snapshot.analysisDepth}
          </div>
        )}
      </div>
      <nav className="masthead-nav">
        {sections.map((section) => (
          <NavLink
            key={section.to}
            to={section.to}
            end={section.end}
            className={({ isActive }) => (isActive ? 'active' : undefined)}
          >
            {section.label}
          </NavLink>
        ))}
      </nav>
    </header>
  );
}

export interface TimeClassBandProps {
  scope: Scope;
  onChange: (scope: Scope) => void;
  summaries: TimeClassSummary[];
  totalGames: number;
}

/**
 * Time class is the product's top-level lens, so it reads as a masthead rule
 * rather than a dropdown: blitz mistakes are a time-pressure signal, rapid
 * mistakes are a preparation signal, and the two should never be averaged.
 */
export function TimeClassBand({ scope, onChange, summaries, totalGames }: TimeClassBandProps) {
  const byClass = new Map(summaries.map((summary) => [summary.timeClass, summary]));

  return (
    <div className="band" role="group" aria-label="Filter by time class">
      <div className="band-label">time class</div>
      <button
        type="button"
        className={`band-option${scope === 'all' ? ' is-active' : ''}`}
        onClick={() => onChange('all')}
        aria-pressed={scope === 'all'}
      >
        All<span className="count numeric">{totalGames}</span>
      </button>
      {TIME_CLASSES.map((timeClass) => {
        const summary = byClass.get(timeClass);
        const count = summary?.games ?? 0;
        return (
          <button
            key={timeClass}
            type="button"
            className={`band-option${scope === timeClass ? ' is-active' : ''}`}
            onClick={() => onChange(timeClass)}
            disabled={count === 0}
            aria-pressed={scope === timeClass}
          >
            {timeClass}
            <span className="count numeric">{count}</span>
          </button>
        );
      })}
    </div>
  );
}

/** `C65:white` — one opening from one side, which is the unit a repertoire has. */
export function openingKey(row: { eco: string; color: string }): string {
  return `${row.eco}:${row.color}`;
}

export function openingLabel(row: OpeningRow): string {
  return `${row.eco} ${row.name} · as ${row.color}`;
}

/** How the current opening reads in a sentence, or null when there isn't one. */
export function lensOpeningLabel(lens: Lens, openings: OpeningRow[]): string | null {
  if (!lens.eco) return null;
  const match = openings.find(
    (row) => row.eco === lens.eco && (!lens.color || row.color === lens.color),
  );
  if (match) return openingLabel(match);
  return lens.color ? `${lens.eco} · as ${lens.color}` : lens.eco;
}

export interface OpeningBandProps {
  lens: Lens;
  openings: OpeningRow[];
  onChange: (lens: Lens) => void;
}

/**
 * The second lens. Time class asks *when* the mistakes happen; this asks *out of
 * what*, which is the question a player can actually prepare against — the leaks in
 * your Sicilian are a different repertoire problem from the ones in your Berlin.
 *
 * It is a select rather than a rule of buttons because a dozen opening names do not
 * fit on a line, and unlike time class the list is different for every player.
 */
export function OpeningBand({ lens, openings, onChange }: OpeningBandProps) {
  // Nothing to choose between: a control offering one option is just noise.
  if (openings.length === 0) return null;

  const selected = lens.eco ? `${lens.eco}:${lens.color ?? ''}` : '';
  // The menu belongs to the time class, and the opening survives a change of time
  // class — so what is selected is not always on the list. It is still what you are
  // looking at, and a control that showed "every opening" instead would be lying.
  const known = openings.some((row) => openingKey(row) === selected);

  return (
    <div className="band band-opening" role="group" aria-label="Filter by opening">
      <div className="band-label">opening</div>
      <select
        className="band-select"
        aria-label="Opening"
        value={selected}
        onChange={(event) => {
          const [eco, color] = event.target.value.split(':');
          onChange(
            eco ? { scope: lens.scope, eco, color: color as 'white' | 'black' } : { scope: lens.scope },
          );
        }}
      >
        <option value="">every opening</option>
        {!known && lens.eco && (
          <option value={selected}>
            {lens.eco}
            {lens.color ? ` · as ${lens.color}` : ''} — carried over from another time class
          </option>
        )}
        {openings.map((row) => (
          <option key={openingKey(row)} value={openingKey(row)}>
            {openingLabel(row)} — {row.games} games, {row.winRate}% wins
          </option>
        ))}
      </select>
      {lens.eco && (
        <button
          type="button"
          className="band-clear"
          onClick={() => onChange({ scope: lens.scope })}
        >
          clear
        </button>
      )}
    </div>
  );
}

export function Empty({
  title,
  children,
}: {
  title: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="empty">
      <h2>{title}</h2>
      <div className="prose">{children}</div>
    </div>
  );
}

export function Loading({ label }: { label: string }) {
  return (
    <div className="empty">
      <div className="label" style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <span className="spinner-dot" />
        {label}
      </div>
    </div>
  );
}

export function ErrorNote({ error }: { error: string }) {
  return (
    <div className="empty">
      <div className="notice">{error}</div>
    </div>
  );
}
