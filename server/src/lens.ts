/**
 * One narrowing, expressed once.
 *
 * Every report — the sheet, the patterns, the scouting report, the coaching — is
 * computed over some subset of a player's games. That subset used to be a time
 * class and nothing else; it is now a time class and, optionally, one opening from
 * one side. Rather than thread two or three arguments through every query, the
 * subset is a value, and this module is the only place that knows how it becomes
 * SQL.
 *
 * The clause and the parameters are built together on purpose: a clause that names
 * `@eco` without a binding for it is a runtime error, and keeping them in one
 * function makes that impossible.
 */
import type { Lens, Scope } from '../../web/src/types.js';
import { lensKey } from '../../web/src/types.js';
import { TIME_CLASSES } from './types.js';

export type { Lens, Scope };
export { lensKey };

/**
 * The `AND ...` tail that narrows a query already selecting one player's games.
 *
 * `alias` is the table alias the games table carries in that query — `g` where it
 * is joined to moves, empty where the query reads `FROM games` directly.
 */
export function lensClause(lens: Lens, alias = 'g'): string {
  const on = alias ? `${alias}.` : '';
  let clause = '';
  if (lens.scope !== 'all') clause += ` AND ${on}time_class = @scope`;
  if (lens.eco) clause += ` AND ${on}eco = @eco`;
  if (lens.eco && lens.color) clause += ` AND ${on}player_color = @color`;
  return clause;
}

/** The bindings that clause needs. Unused keys are harmless; missing ones are not. */
export function lensParams(playerId: number, lens: Lens): Record<string, unknown> {
  return {
    player: playerId,
    scope: lens.scope === 'all' ? null : lens.scope,
    eco: lens.eco ?? null,
    color: lens.color ?? null,
  };
}

/** The same lens looking at a different time class — how the time-class band moves. */
export function withScope(lens: Lens, scope: Scope): Lens {
  return { ...lens, scope };
}

/** The lens with its opening removed: what the opening menu is drawn from. */
export function withoutOpening(lens: Lens): Lens {
  return { scope: lens.scope };
}

/**
 * Reads a lens out of query parameters, keeping only values that could have come
 * from this database. An unknown time class or a malformed ECO code widens the
 * lens rather than narrowing it to nothing — a filter nobody asked for is worse
 * than an empty sheet.
 */
export function parseLens(query: Record<string, unknown>): Lens {
  const lens: Lens = { scope: parseScope(query.scope) ?? 'all' };
  const eco = parseEco(query.eco);
  if (eco) {
    lens.eco = eco;
    const color = String(query.color ?? '').toLowerCase();
    if (color === 'white' || color === 'black') lens.color = color;
  }
  return lens;
}

export function parseScope(value: unknown): Scope | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const lower = String(value).toLowerCase();
  if (lower === 'all') return 'all';
  return (TIME_CLASSES as string[]).includes(lower) ? (lower as Scope) : undefined;
}

/** ECO codes are a letter and two digits, and nothing else is one. */
export function parseEco(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  const upper = String(value).trim().toUpperCase();
  return /^[A-E][0-9]{2}$/.test(upper) ? upper : undefined;
}

/** How a lens reads in a sentence, for briefs and for the offline summariser. */
export function lensLabel(lens: Lens): string {
  const segment = lens.scope === 'all' ? 'all time controls' : lens.scope;
  if (!lens.eco) return segment;
  return lens.color ? `${lens.eco} as ${lens.color}, ${segment}` : `${lens.eco}, ${segment}`;
}
