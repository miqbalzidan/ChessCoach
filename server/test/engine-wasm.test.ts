/**
 * The engine the phone runs has to find the same leaks as the engine the desktop runs.
 *
 * This drives the vendored WebAssembly build through core's own `UciEngine` — the
 * same protocol class the native path uses — and analyses the same fixture games the
 * native engine is tested on. If the two disagree about which moves are blunders,
 * a sheet built on a phone would tell a different story from one built on a computer,
 * and the whole port would be a lie.
 *
 * The engine is loaded rather than imported. The vendored file lives under `web/`,
 * whose package is `"type": "module"`, so Node reads a `.js` there as ESM and the
 * build's CommonJS branch never runs. Copying it to a `.cjs` is the whole workaround.
 */
import { strict as assert } from 'node:assert';
import { test, describe, before, after } from 'node:test';
import { createRequire } from 'node:module';
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { analyseGame } from '../../core/src/analysis.js';
import { QueuedEnginePool, UciEngine, type EnginePool } from '../../core/src/engine.js';
import { createEnginePool } from '../src/engine-node.js';

const ENGINE_DIR = resolve(import.meta.dirname, '../../web/public/engine');
const require = createRequire(import.meta.url);

let work: string;
let shared: EnginePool;

before(async () => {
  work = mkdtempSync(resolve(tmpdir(), 'chesscoach-wasm-'));
  copyFileSync(resolve(ENGINE_DIR, 'stockfish-19-lite-single.js'), resolve(work, 'engine.cjs'));
  // One engine for the whole file. Emscripten's Node branch keeps module-scope state,
  // so a second instance in the same process cannot find its own .wasm — a limitation
  // of running this build under Node, not of the build the browser loads, where each
  // engine is its own Worker with its own module scope.
  shared = await wasmPool();
});

after(() => {
  shared?.close();
  rmSync(work, { recursive: true, force: true });
});

/** One WASM engine, wired to core's UCI client exactly as the browser wires it. */
async function wasmPool(): Promise<EnginePool> {
  const factory = require(resolve(work, 'engine.cjs')) as () => (mod: unknown) => Promise<unknown>;

  const mod: Record<string, unknown> = {
    locateFile: (path: string) =>
      path.endsWith('.wasm')
        ? resolve(ENGINE_DIR, 'stockfish-19-lite-single.wasm')
        : resolve(work, 'engine.cjs'),
  };

  const engine = new UciEngine((command) => {
    (mod as { ccall: Function }).ccall('command', null, ['string'], [command], {
      async: /^go\b/.test(command),
    });
  });
  mod.listener = (line: string) => engine.receive(line);

  await factory()(mod);
  const isReady = mod._isReady as (() => boolean) | undefined;
  while (isReady && !isReady()) await new Promise((r) => setTimeout(r, 10));

  engine.configure(16, 1);
  await engine.newGame();
  return new QueuedEnginePool([engine]);
}

function fixture(name: string): string {
  return readFileSync(resolve(import.meta.dirname, 'fixtures', name), 'utf8');
}

describe('the WebAssembly engine agrees with the native one', () => {
  test('it speaks the protocol and names itself', async () => {
    // The name comes from the `id name` line, so this also proves the handshake ran
    // through core's parser rather than the build's own plumbing.
    assert.match(shared.engineName, /Stockfish/i);

    const lines = await shared.search(
      'r1bqkbnr/pppp1ppp/2n5/4p3/2B1P3/5Q2/PPPP1PPP/RNB1K1NR w KQkq - 4 4',
      10,
      1,
    );
    assert.ok(lines.length > 0, 'no principal variation came back');
    assert.ok(lines[0]!.pv.length > 0, 'the line carried no moves');
  });

  test('it calls the same blunder in the same game', async () => {
    // Scholar's mate: 3...Nf6 allows Qxf7#. An engine that misses this is not usable
    // for the one thing this app does.
    const wasmAnalysis = await analyseGame(shared, fixture('blitz-clocks.pgn'), { depth: 12 });

    const native = createEnginePool(1, 32, 1);
    const nativeAnalysis = await analyseGame(native, fixture('blitz-clocks.pgn'), { depth: 12 });
    native.close();

    assert.equal(wasmAnalysis.moves.length, nativeAnalysis.moves.length);

    const blunder = wasmAnalysis.moves[5]!;
    assert.equal(blunder.san, 'Nf6');
    assert.equal(blunder.classification, 'blunder');

    // The labels that matter are the mistake-class ones: those drive the patterns,
    // the scouting report and everything built on them. `best` is deliberately not
    // compared — it means "you played this engine's single top choice", and two
    // different engines pick differently among near-equal moves.
    const leaks = (moves: typeof wasmAnalysis.moves) =>
      moves
        .filter((m) => ['inaccuracy', 'mistake', 'blunder'].includes(m.classification))
        .map((m) => `${m.ply}:${m.san}:${m.classification}`);

    assert.deepEqual(leaks(wasmAnalysis.moves), leaks(nativeAnalysis.moves));
  });

  test('a clean game stays clean under both engines', async () => {
    // The opposite failure is as bad: an engine that invents blunders would fill the
    // sheet with leaks the player never played.
    const analysis = await analyseGame(shared, fixture('opera.pgn'), { depth: 10 });

    const blunders = analysis.moves.filter((m) => m.classification === 'blunder');
    // Morphy's side of the Opera Game is not a blunder-fest; the losing side's
    // mistakes are real ones, so this asserts a sane count rather than zero.
    assert.ok(blunders.length < analysis.moves.length / 3, `too many blunders: ${blunders.length}`);
  });
});
