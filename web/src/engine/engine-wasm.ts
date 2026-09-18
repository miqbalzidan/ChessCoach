/**
 * Stockfish in the browser: the same UCI conversation, over postMessage.
 *
 * core owns the protocol — the handshake, the `info` parsing, the queue — so this
 * file is only the pipe. The engine build runs as a classic Worker that takes a
 * command string and posts back one line at a time, which is exactly the shape
 * `UciEngine` was written against.
 *
 * The engine is served from `/engine/`, vendored by `scripts/fetch-engine.mjs`, not
 * fetched from a CDN: a sheet that needs no network cannot go and get its engine.
 * Stockfish is GPLv3 and its licence sits beside it there.
 */
import { QueuedEnginePool, UciEngine, type EnginePool } from '../../../core/src/engine.js';

/** Where the vendored build lives, relative to the site root. */
const ENGINE_URL = '/engine/stockfish-19-lite-single.js';

/**
 * A phone has few cores and throttles when warm, so the pool is small. Two engines
 * roughly halve wall-clock time on a modern handset; more of them mostly compete for
 * the same core and generate heat.
 */
const DEFAULT_POOL_SIZE = 2;

/** How long to wait for an engine to finish its handshake before giving up on it. */
const HANDSHAKE_TIMEOUT_MS = 30_000;

function startEngine(hashMb: number): { engine: UciEngine; worker: Worker; ready: Promise<void> } {
  const worker = new Worker(ENGINE_URL);
  const engine = new UciEngine((command) => worker.postMessage(command));

  worker.onmessage = (event: MessageEvent) => {
    const data = event.data;
    if (typeof data !== 'string') return;
    // The build posts one line per message, but it costs nothing to be sure.
    for (const line of data.split('\n')) {
      const trimmed = line.trimEnd();
      if (trimmed) engine.receive(trimmed);
    }
  };
  worker.onerror = (event) => engine.fail(new Error(event.message || 'Engine worker failed'));

  // Hash is small on purpose: phones are memory-constrained, and a fixed-depth search
  // gains little from a large table. Threads must be 1 — this is the single-threaded
  // build, and asking for more would be ignored at best.
  engine.configure(hashMb, 1);

  const ready = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('The chess engine did not start. Try reloading.')),
      HANDSHAKE_TIMEOUT_MS,
    );
    void engine
      .newGame()
      .then(() => resolve())
      .catch(reject)
      .finally(() => clearTimeout(timer));
  });

  return { engine, worker, ready };
}

export interface WasmPool extends EnginePool {
  /** Stops the workers as well as the pool, so a closed pool frees its memory. */
  close(): void;
}

export async function createWasmEnginePool(
  size = DEFAULT_POOL_SIZE,
  hashMb = 16,
): Promise<WasmPool> {
  const started = Array.from({ length: size }, () => startEngine(hashMb));
  await Promise.all(started.map((s) => s.ready));

  const pool = new QueuedEnginePool(started.map((s) => s.engine));
  return {
    get engineName() {
      return pool.engineName;
    },
    get size() {
      return pool.size;
    },
    search: (fen, depth, multipv) => pool.search(fen, depth, multipv),
    ready: () => pool.ready(),
    close() {
      pool.close();
      for (const { worker } of started) worker.terminate();
    },
  };
}

/**
 * How fast this particular phone is, in milliseconds per position.
 *
 * The import warning quotes a number of minutes, and a number of minutes that is
 * wrong by three times is worse than no number at all — someone plans their evening
 * around it. So it is measured on the device rather than assumed from a table: a few
 * real searches at the depth the import will actually use.
 *
 * The positions are ordinary middlegames from different openings, because a quiet
 * position resolves faster than a sharp one and timing only quiet ones would flatter
 * the estimate.
 */
const PROBE_POSITIONS = [
  'r1bqkb1r/pppp1ppp/2n2n2/1B2p3/4P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 4 4',
  'rnbqk2r/pp2bppp/3p1n2/2pP4/4P3/2N2N2/PP3PPP/R1BQKB1R w KQkq - 0 7',
  'r2q1rk1/pp2bppp/2n1bn2/2pp4/3P4/2N1PN2/PPQ1BPPP/R1B2RK1 w - - 4 11',
];

export async function measureMsPerPosition(pool: EnginePool, depth: number): Promise<number> {
  const started = Date.now();
  for (const fen of PROBE_POSITIONS) {
    await pool.search(fen, depth, 1);
  }
  // The pool searches these one after another, so this is per-position time on one
  // engine — which is what the import does too, per engine, in parallel.
  return Math.round((Date.now() - started) / PROBE_POSITIONS.length);
}

/**
 * Seconds a whole import will take on this device, given what it just measured.
 *
 * A game is analysed one position per ply plus the final one, and the pool works on
 * several at once — so the wall clock is the total divided by the pool size.
 */
export function estimateImportSeconds(
  games: number,
  msPerPosition: number,
  poolSize: number,
  averagePlies = 74,
): number {
  const positions = games * (averagePlies + 1);
  return Math.round((positions * msPerPosition) / Math.max(1, poolSize) / 1000);
}
