/**
 * Talking UCI, without caring what is on the other end of the wire.
 *
 * Stockfish speaks the same line-oriented text protocol whether it is a native
 * process on a server reading stdin, or a WASM build in a phone's browser taking
 * `postMessage`. The protocol is the interesting part and the transport is not, so
 * the protocol lives here and each host brings its own pipe: it hands `UciEngine` a
 * `send` function, and feeds whatever comes back to `receive`.
 *
 * `EnginePool` is here for the same reason. Analysis is embarrassingly parallel
 * across positions, so throughput comes from running several engines off one queue —
 * which is arithmetic, not I/O, and does not need rewriting per platform.
 */
import type { EngineLine, Score } from './types.js';

export type { EngineLine, Score };

/** What a host must provide: a way to send one UCI command. */
export type SendCommand = (command: string) => void;

interface PendingSearch {
  resolve: (lines: EngineLine[]) => void;
  reject: (err: Error) => void;
  multipv: number;
  lines: Map<number, EngineLine>;
}

/**
 * One engine, mid-conversation. Commands are serialised by the pool that owns it —
 * a second search before the first resolves is a programming error, not a queue.
 */
export class UciEngine {
  private pending: PendingSearch | null = null;
  private readyWaiters: Array<{ resolve: () => void; reject: (err: Error) => void }> = [];
  private currentMultipv = 0;
  name = 'stockfish';

  constructor(private readonly send: SendCommand) {}

  /** Feed one line of engine output. Partial lines are the transport's problem. */
  receive(line: string): void {
    if (line.startsWith('id name ')) {
      this.name = line.slice('id name '.length).trim();
      return;
    }
    if (line === 'readyok') {
      this.readyWaiters.shift()?.resolve();
      return;
    }
    if (!this.pending) return;

    if (line.startsWith('info ') && line.includes(' pv ')) {
      const parsed = parseInfoLine(line);
      if (parsed) this.pending.lines.set(parsed.multipv, parsed.line);
      return;
    }
    if (line.startsWith('bestmove')) {
      const pending = this.pending;
      this.pending = null;
      const ordered = [...pending.lines.entries()].sort((a, b) => a[0] - b[0]).map(([, l]) => l);
      pending.resolve(ordered);
    }
  }

  /**
   * Something went wrong with the transport. A dead engine will never send
   * `readyok`, so without this every waiter hangs forever instead of surfacing as
   * an import error.
   */
  fail(err: Error): void {
    const pending = this.pending;
    this.pending = null;
    pending?.reject(err);

    const waiters = this.readyWaiters;
    this.readyWaiters = [];
    for (const waiter of waiters) waiter.reject(err);
  }

  private ready(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.readyWaiters.push({ resolve, reject });
      this.send('isready');
    });
  }

  async search(fen: string, depth: number, multipv: number): Promise<EngineLine[]> {
    if (this.pending) throw new Error('Engine is already searching');
    if (this.currentMultipv !== multipv) {
      this.send(`setoption name MultiPV value ${multipv}`);
      this.currentMultipv = multipv;
    }
    await this.ready();
    return new Promise<EngineLine[]>((resolve, reject) => {
      this.pending = { resolve, reject, multipv, lines: new Map() };
      this.send(`position fen ${fen}`);
      this.send(`go depth ${depth}`);
    });
  }

  async newGame(): Promise<void> {
    this.send('ucinewgame');
    await this.ready();
  }

  configure(hashMb: number, threads: number): void {
    this.send('uci');
    this.send(`setoption name Hash value ${hashMb}`);
    this.send(`setoption name Threads value ${threads}`);
  }

  quit(): void {
    this.send('quit');
  }
}

export function parseInfoLine(line: string): { multipv: number; line: EngineLine } | null {
  const tokens = line.split(' ');
  let depth = 0;
  let multipv = 1;
  let score: Score | null = null;
  let pv: string[] = [];

  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token === 'depth') depth = Number(tokens[i + 1]);
    else if (token === 'multipv') multipv = Number(tokens[i + 1]);
    else if (token === 'score') {
      const kind = tokens[i + 1];
      const value = Number(tokens[i + 2]);
      if (kind === 'cp') score = { cp: value, mate: null };
      else if (kind === 'mate') score = { cp: null, mate: value };
    } else if (token === 'pv') {
      pv = tokens.slice(i + 1).filter(Boolean);
      break;
    }
  }

  if (!score || pv.length === 0) return null;
  return { multipv, line: { score, pv, depth } };
}

interface Job {
  fen: string;
  depth: number;
  multipv: number;
  resolve: (lines: EngineLine[]) => void;
  reject: (err: Error) => void;
}

/**
 * What the analysis asks of an engine, and the whole of it. Anything satisfying
 * this can drive the app — which is how the same analysis runs against a native
 * process and against a WASM build without knowing which it has.
 */
export interface EnginePool {
  readonly engineName: string;
  readonly size: number;
  search(fen: string, depth: number, multipv?: number): Promise<EngineLine[]>;
  ready(): Promise<void>;
  close(): void;
}

/** A fixed set of engines fed from one queue. */
export class QueuedEnginePool implements EnginePool {
  private idle: UciEngine[] = [];
  private queue: Job[] = [];
  private closed = false;

  constructor(private engines: UciEngine[]) {
    this.idle = [...engines];
  }

  get engineName(): string {
    return this.engines[0]?.name ?? 'stockfish';
  }

  get size(): number {
    return this.engines.length;
  }

  search(fen: string, depth: number, multipv = 1): Promise<EngineLine[]> {
    if (this.closed) return Promise.reject(new Error('Engine pool is closed'));
    return new Promise<EngineLine[]>((resolve, reject) => {
      this.queue.push({ fen, depth, multipv, resolve, reject });
      this.pump();
    });
  }

  private pump(): void {
    while (this.idle.length > 0 && this.queue.length > 0) {
      const engine = this.idle.pop()!;
      const job = this.queue.shift()!;
      engine
        .search(job.fen, job.depth, job.multipv)
        .then(job.resolve, job.reject)
        .finally(() => {
          this.idle.push(engine);
          this.pump();
        });
    }
  }

  /** Resolves once every engine has completed its UCI handshake. */
  async ready(): Promise<void> {
    await Promise.all(this.engines.map((e) => e.newGame()));
  }

  close(): void {
    this.closed = true;
    for (const engine of this.engines) engine.quit();
    this.engines = [];
    this.idle = [];
  }
}
