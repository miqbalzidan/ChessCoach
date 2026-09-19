/**
 * Self-hosts the WebAssembly Stockfish the phone runs on.
 *
 * Same reasoning as the fonts: a leak sheet that works with no network cannot fetch
 * its engine from a CDN. The two files land in `web/public/engine/` and are committed,
 * so a clone builds offline and CI does not pull 200 MB to get 1.8 MB of them.
 *
 * Which build, and why:
 *
 *   stockfish-19.wasm             99 MB   full net, multi-threaded
 *   stockfish-19-single.wasm      99 MB   full net, single-threaded
 *   stockfish-19-lite.wasm       1.6 MB   small net, multi-threaded
 *   stockfish-19-lite-single.wasm 1.8 MB  small net, single-threaded   ← this one
 *
 * Multi-threaded builds need SharedArrayBuffer, which needs COOP/COEP response
 * headers, which needs a server this design deliberately does not have. And 99 MB is
 * not a thing to precache onto someone's phone. The package's own README recommends
 * the lite single-threaded build for exactly these reasons.
 *
 * Measured against the native Stockfish 16 this repo uses on a desktop, the lite
 * build is not slower — 79ms vs 115ms per position at depth 12 — and on 179 moves of
 * real games it agreed about every blunder and disagreed only on two borderline
 * inaccuracies.
 *
 * Stockfish is GPLv3, so the licence travels with the binary and the source it was
 * built from is named below.
 *
 * Run: node scripts/fetch-engine.mjs
 */
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

const PACKAGE = 'stockfish@19.0.0';
const SOURCE = 'https://github.com/nmrugg/stockfish.js';
const FILES = ['stockfish-19-lite-single.js', 'stockfish-19-lite-single.wasm', 'Copying.txt'];
const OUT_DIR = resolve(import.meta.dirname, '../web/public/engine');

const work = mkdtempSync(resolve(tmpdir(), 'chesscoach-engine-'));
try {
  console.log(`Installing ${PACKAGE} (the published package is large; only the lite build is kept)…`);
  writeFileSync(resolve(work, 'package.json'), JSON.stringify({ name: 'tmp', private: true }));
  execFileSync('npm', ['install', '--no-audit', '--no-fund', '--silent', PACKAGE], {
    cwd: work,
    stdio: 'inherit',
  });

  mkdirSync(OUT_DIR, { recursive: true });
  for (const file of FILES) {
    const from = resolve(work, 'node_modules/stockfish', file === 'Copying.txt' ? file : `bin/${file}`);
    const to = resolve(OUT_DIR, file === 'Copying.txt' ? 'LICENSE-stockfish.txt' : file);
    copyFileSync(from, to);
    console.log(`  ${(statSync(to).size / 1024).toFixed(0)} KB  ${to.replace(`${process.cwd()}/`, '')}`);
  }

  writeFileSync(
    resolve(OUT_DIR, 'README.md'),
    `# Stockfish, in WebAssembly

Vendored from \`${PACKAGE}\` by \`scripts/fetch-engine.mjs\`, unmodified.

Stockfish is free software under the **GNU General Public License v3**, whose text is
in \`LICENSE-stockfish.txt\`. The corresponding source is at ${SOURCE}, which is in
turn a build of <https://github.com/official-stockfish/Stockfish>.

Only the lite single-threaded build is kept: the full net is 99 MB, and every
multi-threaded build needs SharedArrayBuffer and therefore COOP/COEP headers that a
statically hosted app cannot set.
`,
  );
  console.log(`\nDone. Run this again to update the engine.`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
