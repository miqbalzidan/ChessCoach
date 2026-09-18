/**
 * Talking to the copy of the app running in this phone.
 *
 * One Worker, one message per request, matched by id. The shapes on both sides are
 * the ones the HTTP API already returns, so `request()` in api.ts can hand paths
 * here without any screen knowing the difference.
 *
 * Local mode is opt-in and remembered: a browser pointed at a dev server should keep
 * using it, and someone who chose to run the whole thing on their phone should not
 * have to choose again on every launch.
 */
import type { WorkerRequest, WorkerResponse } from './worker.js';

const MODE_KEY = 'chesscoach.local';

let worker: Worker | null = null;
let nextId = 1;
const pending = new Map<number, { resolve: (value: unknown) => void; reject: (err: Error) => void }>();

export class LocalError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'LocalError';
  }
}

/** True when this browser is the whole app rather than a client of a server. */
export function inLocalMode(): boolean {
  try {
    return localStorage.getItem(MODE_KEY) === 'on';
  } catch {
    // Private windows and blocked storage: treat as a normal client.
    return false;
  }
}

export function setLocalMode(on: boolean): void {
  try {
    if (on) localStorage.setItem(MODE_KEY, 'on');
    else localStorage.removeItem(MODE_KEY);
  } catch {
    // Nothing to do; the mode simply will not be remembered.
  }
}

function ensureWorker(): Worker {
  if (worker) return worker;

  worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });

  worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
    const { id, ok, data, error, status } = event.data;
    const waiter = pending.get(id);
    if (!waiter) return;
    pending.delete(id);
    if (ok) waiter.resolve(data);
    else waiter.reject(new LocalError(error ?? 'Request failed', status ?? 500));
  };

  // Release the database before the next page asks for it. A Worker outlives its
  // page for a moment during a reload, and OPFS lets exactly one holder open a file —
  // so without this, a pull-to-refresh races the old Worker and the library's own
  // recovery path can clear the pool while trying to take it. Terminating here is
  // what makes reloading safe.
  addEventListener('pagehide', () => {
    worker?.terminate();
    worker = null;
  });

  worker.onerror = (event) => {
    // Nothing will ever answer these, so fail them rather than leave the UI spinning.
    const err = new LocalError(event.message || 'The app stopped responding', 500);
    for (const [, waiter] of pending) waiter.reject(err);
    pending.clear();
    worker = null;
  };

  return worker;
}

export function requestLocal<T>(path: string, init?: RequestInit): Promise<T> {
  const id = nextId++;
  const message: WorkerRequest = {
    id,
    path,
    method: (init?.method ?? 'GET').toUpperCase(),
    body: init?.body ? JSON.parse(String(init.body)) : undefined,
  };

  return new Promise<T>((resolve, reject) => {
    pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
    ensureWorker().postMessage(message);
  });
}

/** Writes an exported snapshot's games into this device's own database. */
export function seedFromFile(snapshot: unknown): Promise<{
  player: string;
  games: number;
  moves: number;
  duplicates: number;
  mixedAnalysis: boolean;
}> {
  return requestLocal('/local/seed', { method: 'POST', body: JSON.stringify(snapshot) });
}

/**
 * How long an import of this many games would take here, measured on this device.
 * Returns null if the engine cannot be reached at all, in which case the caller
 * should say nothing rather than guess.
 */
export async function estimateImport(
  games: number,
): Promise<{ seconds: number; msPerPosition: number; poolSize: number } | null> {
  try {
    return await requestLocal(`/local/estimate?games=${games}`);
  } catch {
    return null;
  }
}
