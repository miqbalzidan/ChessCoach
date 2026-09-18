import { parsePgn } from './analysis.js';
import { TIME_CLASSES, type ImportedGame, type TimeClass } from './types.js';

let API_BASE = 'https://api.chess.com/pub';

/**
 * Chess.com rejects requests without a descriptive User-Agent, and asks that tools
 * identify themselves so they can be contacted about traffic.
 *
 * A browser will not let us send one: User-Agent is a forbidden header name, so the
 * fetch below silently drops it there. That is why this is configuration rather than
 * a constant — a host that cannot set it says so, and the caller can decide what to
 * do about a request Chess.com may refuse.
 */
let userAgent = 'ChessCoach/0.1 (personal game analysis; +https://github.com/)';

export interface ChessComConfig {
  apiBase?: string;
  userAgent?: string;
}

export function configureChessCom(config: ChessComConfig): void {
  if (config.apiBase) API_BASE = config.apiBase;
  if (config.userAgent) userAgent = config.userAgent;
}

export class ChessComError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'ChessComError';
  }
}

interface RawPlayerGame {
  url?: string;
  pgn?: string;
  time_control?: string;
  end_time?: number;
  rated?: boolean;
  time_class?: string;
  rules?: string;
  uuid?: string;
  white?: { rating?: number; result?: string; username?: string };
  black?: { rating?: number; result?: string; username?: string };
}

async function request<T>(url: string, attempt = 0): Promise<T> {
  const response = await fetch(url, {
    headers: { 'User-Agent': userAgent, Accept: 'application/json' },
  });

  // Chess.com throttles bursts with 429; backing off is the documented remedy.
  if (response.status === 429 && attempt < 4) {
    await sleep(2 ** attempt * 1000);
    return request<T>(url, attempt + 1);
  }
  if (response.status === 404) {
    throw new ChessComError('No such Chess.com player', 404);
  }
  if (!response.ok) {
    throw new ChessComError(`Chess.com returned ${response.status}`, response.status);
  }
  return (await response.json()) as T;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Monthly archive URLs, oldest first. */
export async function fetchArchives(username: string): Promise<string[]> {
  const data = await request<{ archives?: string[] }>(
    `${API_BASE}/player/${encodeURIComponent(username.toLowerCase())}/games/archives`,
  );
  return data.archives ?? [];
}

export interface FetchGamesOptions {
  /** Only games finished at or after this unix timestamp. */
  since?: number;
  /** Only games finished at or before this unix timestamp. */
  until?: number;
  /** Stop once this many games have been collected, newest first. */
  limit?: number;
  timeClasses?: TimeClass[];
  onArchive?: (done: number, total: number) => void;
}

/**
 * Walks archives newest-first so a "last 50 games" import touches one or two
 * months rather than a player's entire history.
 */
export async function fetchGames(
  username: string,
  options: FetchGamesOptions = {},
): Promise<ImportedGame[]> {
  const archives = (await fetchArchives(username)).slice().reverse();
  const wanted = new Set(options.timeClasses ?? TIME_CLASSES);
  const collected: ImportedGame[] = [];

  for (const [index, archive] of archives.entries()) {
    if (options.limit && collected.length >= options.limit) break;
    if (options.since && !archiveCouldContain(archive, options.since)) break;

    const data = await request<{ games?: RawPlayerGame[] }>(archive);
    const games = (data.games ?? []).slice().reverse();

    for (const raw of games) {
      if (options.limit && collected.length >= options.limit) break;
      const game = normaliseGame(raw, username);
      if (!game) continue;
      if (!wanted.has(game.timeClass)) continue;
      if (options.since && game.endTime < options.since) continue;
      if (options.until && game.endTime > options.until) continue;
      collected.push(game);
    }

    options.onArchive?.(index + 1, archives.length);
  }

  return collected;
}

/** Archive URLs end in /YYYY/MM, so whole months can be skipped without fetching. */
function archiveCouldContain(archiveUrl: string, since: number): boolean {
  const match = /\/(\d{4})\/(\d{2})$/.exec(archiveUrl);
  if (!match) return true;
  const endOfMonth = Date.UTC(Number(match[1]), Number(match[2]), 1) / 1000;
  return endOfMonth >= since;
}

export function normaliseGame(raw: RawPlayerGame, username: string): ImportedGame | null {
  if (!raw.pgn) return null;
  // Variants share the endpoint but not the evaluation model.
  if (raw.rules && raw.rules !== 'chess') return null;

  const timeClass = normaliseTimeClass(raw.time_class);
  if (!timeClass) return null;

  const headers = safeHeaders(raw.pgn);
  const white = raw.white?.username ?? headers.White ?? 'white';
  const black = raw.black?.username ?? headers.Black ?? 'black';
  const externalId = raw.uuid ?? raw.url ?? `${white}-${black}-${raw.end_time ?? 0}`;

  return {
    externalId,
    source: 'chess.com',
    url: raw.url ?? null,
    pgn: raw.pgn,
    timeClass,
    timeControl: raw.time_control ?? headers.TimeControl ?? '-',
    endTime: raw.end_time ?? parsePgnEndTime(headers),
    rated: raw.rated !== false,
    whiteUsername: white,
    blackUsername: black,
    whiteRating: raw.white?.rating ?? numberOrNull(headers.WhiteElo),
    blackRating: raw.black?.rating ?? numberOrNull(headers.BlackElo),
    whiteResult: raw.white?.result ?? resultFromHeaders(headers, 'white'),
    blackResult: raw.black?.result ?? resultFromHeaders(headers, 'black'),
    eco: headers.ECO ?? null,
    ecoName: ecoNameFromHeaders(headers),
  };
}

function normaliseTimeClass(value: string | undefined): TimeClass | null {
  if (!value) return null;
  const lower = value.toLowerCase();
  return (TIME_CLASSES as string[]).includes(lower) ? (lower as TimeClass) : null;
}

function safeHeaders(pgn: string): Record<string, string> {
  try {
    return parsePgn(pgn).headers;
  } catch {
    return {};
  }
}

function numberOrNull(value: string | undefined): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function parsePgnEndTime(headers: Record<string, string>): number {
  const date = headers.UTCDate ?? headers.Date;
  const time = headers.UTCTime ?? '00:00:00';
  if (!date) return Math.floor(Date.now() / 1000);
  const iso = `${date.replace(/\./g, '-')}T${time}Z`;
  const parsed = Date.parse(iso);
  return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : Math.floor(Date.now() / 1000);
}

function resultFromHeaders(headers: Record<string, string>, color: 'white' | 'black'): string {
  const result = headers.Result;
  if (result === '1-0') return color === 'white' ? 'win' : 'checkmated';
  if (result === '0-1') return color === 'black' ? 'win' : 'checkmated';
  if (result === '1/2-1/2') return 'agreed';
  return 'unknown';
}

/**
 * The opening name only exists in the ECOUrl slug, so it is unpacked from there
 * rather than shipping an ECO table that would go stale.
 */
export function ecoNameFromHeaders(headers: Record<string, string>): string | null {
  if (headers.Opening) return headers.Opening;
  const url = headers.ECOUrl;
  if (!url) return null;
  const slug = url.split('/').pop();
  if (!slug) return null;
  return decodeURIComponent(slug).replace(/-/g, ' ').trim() || null;
}

/** Chess.com reports the result per player; this collapses it to the usual three. */
export function outcomeFor(result: string): 'win' | 'loss' | 'draw' {
  if (result === 'win') return 'win';
  const draws = new Set([
    'agreed',
    'repetition',
    'stalemate',
    'insufficient',
    'timevsinsufficient',
    '50move',
  ]);
  return draws.has(result) ? 'draw' : 'loss';
}
