/**
 * Stockfish as a native process: finding the binary, spawning it, and pumping its
 * stdout into core's UCI client.
 *
 * Everything about the protocol lives in core. What is left here is genuinely
 * platform-specific — where the installers put the executable, and how to turn a
 * byte stream into whole lines.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { cpus, platform } from 'node:os';
import { join } from 'node:path';
import { QueuedEnginePool, UciEngine, type EnginePool } from '../../core/src/engine.js';

export type { EnginePool };

const CANDIDATE_PATHS = [
  process.env.STOCKFISH_PATH,
  '/usr/games/stockfish',
  '/usr/local/bin/stockfish',
  '/opt/homebrew/bin/stockfish',
  ...(platform() === 'win32' ? windowsCandidates() : []),
  'stockfish',
].filter((p): p is string => Boolean(p));

/**
 * winget (and choco/scoop) installs land the binary under a package-specific
 * directory rather than on PATH as a plain `stockfish.exe`, so a bare command
 * name never resolves on Windows even after a PATH refresh. This looks in the
 * places those installers actually put it.
 */
function windowsCandidates(): string[] {
  const candidates = [
    'C:\\ProgramData\\chocolatey\\bin\\stockfish.exe',
    process.env.USERPROFILE ? join(process.env.USERPROFILE, 'scoop\\shims\\stockfish.exe') : null,
  ].filter((p): p is string => Boolean(p));

  const wingetRoot = process.env.LOCALAPPDATA
    ? join(process.env.LOCALAPPDATA, 'Microsoft\\WinGet\\Packages')
    : null;
  if (wingetRoot && existsSync(wingetRoot)) {
    try {
      const pkgDir = readdirSync(wingetRoot).find((name) => name.startsWith('Stockfish.Stockfish_'));
      if (pkgDir) {
        const stockfishDir = join(wingetRoot, pkgDir, 'stockfish');
        if (existsSync(stockfishDir)) {
          const exe = readdirSync(stockfishDir).find((name) => name.toLowerCase().endsWith('.exe'));
          if (exe) candidates.push(join(stockfishDir, exe));
        }
      }
    } catch {
      // Best-effort discovery; fall through to the remaining candidates.
    }
  }

  return candidates;
}

export function resolveStockfishPath(): string {
  for (const candidate of CANDIDATE_PATHS) {
    if (candidate === 'stockfish' || existsSync(candidate)) return candidate;
  }
  throw new Error(
    'Stockfish not found. Install it (apt install stockfish / brew install stockfish / winget install Stockfish.Stockfish) or set STOCKFISH_PATH.',
  );
}

/** One spawned process wired to one UCI client. */
function spawnEngine(binary: string, hashMb: number, threads: number): UciEngine {
  const proc: ChildProcessWithoutNullStreams = spawn(binary, [], { stdio: 'pipe' });
  const engine = new UciEngine((command) => {
    proc.stdin.write(`${command}\n`);
  });

  proc.stdout.setEncoding('utf8');

  // stdout arrives in arbitrary chunks; the protocol is line-oriented.
  let buffer = '';
  proc.stdout.on('data', (chunk: string) => {
    buffer += chunk;
    let index = buffer.indexOf('\n');
    while (index >= 0) {
      const line = buffer.slice(0, index).trimEnd();
      buffer = buffer.slice(index + 1);
      if (line) engine.receive(line);
      index = buffer.indexOf('\n');
    }
  });

  proc.on('error', (err) => engine.fail(err));
  proc.on('exit', () => engine.fail(new Error('Stockfish exited')));

  engine.configure(hashMb, threads);
  return engine;
}

export function createEnginePool(
  size = defaultPoolSize(),
  hashMb = 64,
  threads = 1,
): EnginePool {
  const binary = resolveStockfishPath();
  const engines = Array.from({ length: size }, () => spawnEngine(binary, hashMb, threads));
  return new QueuedEnginePool(engines);
}

function defaultPoolSize(): number {
  const configured = Number(process.env.ENGINE_POOL_SIZE);
  if (Number.isFinite(configured) && configured > 0) return Math.floor(configured);
  return Math.max(1, Math.min(6, cpus().length - 1));
}
