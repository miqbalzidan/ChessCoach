import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import { cpus } from 'node:os';
import { EventEmitter } from 'node:events';
import type { EngineLine, Score } from './types.js';

const CANDIDATE_PATHS = [
  process.env.STOCKFISH_PATH,
  '/usr/games/stockfish',
  '/usr/local/bin/stockfish',
  '/opt/homebrew/bin/stockfish',
  'stockfish',
].filter((p): p is string => Boolean(p));

export function resolveStockfishPath(): string {
  for (const candidate of CANDIDATE_PATHS) {
    if (candidate === 'stockfish' || existsSync(candidate)) return candidate;
  }
  throw new Error(
    'Stockfish not found. Install it (apt install stockfish / brew install stockfish) or set STOCKFISH_PATH.',
  );
}

interface PendingSearch {
  resolve: (lines: EngineLine[]) => void;
  reject: (err: Error) => void;
  multipv: number;
  lines: Map<number, EngineLine>;
}

/** One long-lived UCI process. Commands are serialised by the pool that owns it. */
class Engine extends EventEmitter {
  private proc: ChildProcessWithoutNullStreams;
  private buffer = '';
  private pending: PendingSearch | null = null;
  private readyWaiters: Array<() => void> = [];
  private currentMultipv = 0;
  name = 'stockfish';

  constructor(binary: string, hashMb: number, threads: number) {
    super();
    this.proc = spawn(binary, [], { stdio: 'pipe' });
    this.proc.stdout.setEncoding('utf8');
    this.proc.stdout.on('data', (chunk: string) => this.onData(chunk));
    this.proc.on('error', (err) => this.failPending(err));
    this.proc.on('exit', () => this.failPending(new Error('Stockfish exited unexpectedly')));
    this.send('uci');
    this.send(`setoption name Hash value ${hashMb}`);
    this.send(`setoption name Threads value ${threads}`);
  }

  private send(cmd: string): void {
    this.proc.stdin.write(`${cmd}\n`);
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    let index: number;
    while ((index = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, index).trimEnd();
      this.buffer = this.buffer.slice(index + 1);
      if (line) this.onLine(line);
    }
  }

  private onLine(line: string): void {
    if (line.startsWith('id name ')) {
      this.name = line.slice('id name '.length).trim();
      return;
    }
    if (line === 'readyok') {
      const waiter = this.readyWaiters.shift();
      waiter?.();
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
      const ordered = [...pending.lines.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([, l]) => l);
      pending.resolve(ordered);
    }
  }

  private failPending(err: Error): void {
    const pending = this.pending;
    this.pending = null;
    pending?.reject(err);
  }

  private ready(): Promise<void> {
    return new Promise((resolve) => {
      this.readyWaiters.push(resolve);
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

  quit(): void {
    this.send('quit');
    this.proc.kill();
  }
}

function parseInfoLine(line: string): { multipv: number; line: EngineLine } | null {
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
 * A fixed set of engine processes fed from one queue. Analysis is embarrassingly
 * parallel across positions, so throughput scales with processes rather than with
 * Stockfish's own threading, which stalls on short fixed-depth searches.
 */
export class EnginePool {
  private engines: Engine[] = [];
  private idle: Engine[] = [];
  private queue: Job[] = [];
  private closed = false;

  constructor(size = defaultPoolSize(), hashMb = 64, threads = 1) {
    const binary = resolveStockfishPath();
    for (let i = 0; i < size; i += 1) {
      const engine = new Engine(binary, hashMb, threads);
      this.engines.push(engine);
      this.idle.push(engine);
    }
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

function defaultPoolSize(): number {
  const configured = Number(process.env.ENGINE_POOL_SIZE);
  if (Number.isFinite(configured) && configured > 0) return Math.floor(configured);
  return Math.max(1, Math.min(6, cpus().length - 1));
}
