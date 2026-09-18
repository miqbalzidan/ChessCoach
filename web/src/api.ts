import type {
  Coaching,
  Dashboard,
  Game,
  GameResult,
  Job,
  Lens,
  Move,
  OpeningRow,
  Pattern,
  Player,
  Profile,
  Scope,
  Settings,
  TimeClass,
} from './types';
import { inSnapshotMode, serveFromSnapshot, SnapshotError } from './snapshot';

const BASE = '/api';

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  // With a snapshot loaded there is no server to ask. Every screen above this line
  // is unchanged — they call the same api.* methods and never learn the difference.
  if (inSnapshotMode()) {
    try {
      return serveFromSnapshot<T>(path, init);
    } catch (error) {
      if (error instanceof SnapshotError) throw new ApiError(error.message, error.status);
      throw error;
    }
  }

  const response = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...init?.headers },
  });

  if (!response.ok) {
    let message = `Request failed (${response.status})`;
    try {
      const body = (await response.json()) as { error?: string };
      if (body.error) message = body.error;
    } catch {
      // Keep the status-based message.
    }
    throw new ApiError(message, response.status);
  }

  return (await response.json()) as T;
}

function post<T>(path: string, body: unknown): Promise<T> {
  return request<T>(path, { method: 'POST', body: JSON.stringify(body) });
}

/** The lens as the read endpoints take it. Colour only travels with an opening. */
function lensQuery(lens: Lens, extra: Record<string, string> = {}): string {
  const query = new URLSearchParams({ scope: lens.scope, ...extra });
  if (lens.eco) {
    query.set('eco', lens.eco);
    if (lens.color) query.set('color', lens.color);
  }
  return query.toString();
}

export const api = {
  health: () =>
    request<{ ok: boolean; engine: string; engines: number; coaching: string; defaultDepth: number }>(
      '/health',
    ),

  players: () => request<{ players: Player[] }>('/players'),

  importChessCom: (body: {
    username: string;
    since?: number;
    limit?: number;
    timeClasses?: TimeClass[];
    depth?: number;
  }) => post<{ jobId: number }>('/import/chesscom', body),

  importPgn: (body: { username: string; pgn: string; depth?: number }) =>
    post<{ jobId: number }>('/import/pgn', body),

  job: (id: number) => request<{ job: Job }>(`/jobs/${id}`),

  latestJob: (username: string) =>
    request<{ job: Job | null }>(`/players/${encodeURIComponent(username)}/job`),

  resync: (username: string) =>
    post<{ jobId: number }>(`/players/${encodeURIComponent(username)}/resync`, {}),

  analysePending: (username: string) =>
    post<{ jobId: number }>(`/players/${encodeURIComponent(username)}/analyse-pending`, {}),

  games: (
    username: string,
    params: {
      timeClass?: Scope;
      result?: GameResult | 'all';
      eco?: string;
      color?: 'white' | 'black';
      opponent?: string;
      limit?: number;
      offset?: number;
      analysedOnly?: boolean;
    } = {},
  ) => {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== '') query.set(key, String(value));
    }
    return request<{ games: Game[]; total: number }>(
      `/players/${encodeURIComponent(username)}/games?${query}`,
    );
  },

  game: (id: number) => request<{ game: Game; moves: Move[] }>(`/games/${id}`),

  analyseGame: (id: number) => post<{ game: Game; moves: Move[] }>(`/games/${id}/analyse`, {}),

  dashboard: (username: string, lens: Lens) =>
    request<Dashboard>(`/players/${encodeURIComponent(username)}/dashboard?${lensQuery(lens)}`),

  profile: (username: string, lens: Lens) =>
    request<{ scope: Scope; lens: Lens; profile: Profile }>(
      `/players/${encodeURIComponent(username)}/profile?${lensQuery(lens)}`,
    ),

  /** The openings this player has a real sample of, for the filter to offer. */
  openings: (username: string, scope: Scope) =>
    request<{ scope: Scope; openings: OpeningRow[] }>(
      `/players/${encodeURIComponent(username)}/openings?scope=${scope}`,
    ),

  patterns: (username: string, lens: Lens, min = 3) =>
    request<{ scope: Scope; lens: Lens; patterns: Pattern[]; labels: Record<string, string> }>(
      `/players/${encodeURIComponent(username)}/patterns?${lensQuery(lens, { min: String(min) })}`,
    ),

  coaching: (username: string, lens: Lens, refresh = false) =>
    request<{ scope: Scope; lens: Lens; coaching: Coaching; cached: boolean }>(
      `/players/${encodeURIComponent(username)}/coaching?${lensQuery(lens, { refresh: String(refresh) })}`,
    ),

  settings: () => request<Settings>('/settings'),

  saveSettings: (body: { analysisDepth: number }) =>
    post<{ analysisDepth: number }>('/settings', body),

  deleteGames: (username: string) =>
    request<{ ok: boolean }>(`/players/${encodeURIComponent(username)}/games`, {
      method: 'DELETE',
    }),
};
