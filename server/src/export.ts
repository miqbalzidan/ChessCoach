/**
 * Freezes an analysed player into a snapshot: every number the read-only screens
 * ask for, already computed.
 *
 * The phone has no engine and no database. Rather than teach it to do the work,
 * this does the work once here and hands over the results — which is cheap,
 * because the work is already done and sitting in SQLite.
 *
 * Nothing in here recomputes anything. It calls exactly the functions the HTTP
 * API calls and serialises what they return, so a snapshot cannot disagree with
 * the live app.
 */
import { gzipSync } from 'node:zlib';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { Scope, Snapshot, SnapshotScope } from '../../web/src/types.js';
import { SNAPSHOT_VERSION } from '../../web/src/types.js';
import { getDb, getSetting, type DB } from './db.js';
import { findPlayer, getMoves, listGames } from './store.js';
import { dashboard } from './stats.js';
import { detectPatterns } from './patterns.js';
import { profile } from './profile.js';
import { MOTIF_LABELS } from './motifs.js';
import { generateCoaching, readCachedCoaching, writeCachedCoaching } from './coach.js';

const SCOPES: Scope[] = ['all', 'bullet', 'blitz', 'rapid', 'daily'];
const MIN_OCCURRENCES = 3;

/** Games are listed without their PGN — no screen reads it, and it is 10% of the payload. */
function stripPgn<T extends { pgn: string }>(game: T): Omit<T, 'pgn'> {
  const { pgn: _pgn, ...rest } = game;
  return rest;
}

export interface ExportOptions {
  /** Ask Claude for any coaching a scope has not got yet. Off by default: exporting
   *  should not quietly spend money, and the offline summariser is already good. */
  generateMissingCoaching?: boolean;
  onProgress?: (message: string) => void;
}

export async function buildSnapshot(
  db: DB,
  username: string,
  options: ExportOptions = {},
): Promise<Snapshot> {
  const player = findPlayer(db, username);
  if (!player) throw new Error(`No such player: ${username}`);
  const note = options.onProgress ?? (() => {});

  // Everything, not a page of it — the snapshot is the whole sheet.
  const { games } = listGames(db, player.id, { limit: Number.MAX_SAFE_INTEGER, offset: 0 });
  note(`${games.length} games`);

  const moves: Record<string, ReturnType<typeof getMoves>> = {};
  for (const game of games) {
    if (game.analysed_at) moves[String(game.id)] = getMoves(db, game.id);
  }
  note(`${Object.values(moves).reduce((sum, list) => sum + list.length, 0)} moves`);

  const scopes = {} as Record<Scope, SnapshotScope>;
  for (const scope of SCOPES) {
    const stats = dashboard(db, player.id, scope);
    const patterns = detectPatterns(db, player.id, scope, { minOccurrences: MIN_OCCURRENCES });

    let coaching = readCachedCoaching(db, player.id, scope);
    if (!coaching && options.generateMissingCoaching && stats.headline.analysedGames > 0) {
      note(`coaching for ${scope}…`);
      coaching = await generateCoaching({ username: player.username, scope, stats, patterns });
      writeCachedCoaching(db, player.id, scope, coaching);
    }

    // The dashboard endpoint answers with the player spread in alongside the stats,
    // so the snapshot has to carry the same shape or the screens read undefined.
    scopes[scope] = {
      dashboard: { player, ...stats } as SnapshotScope['dashboard'],
      patterns: patterns as SnapshotScope['patterns'],
      labels: MOTIF_LABELS,
      coaching: coaching as SnapshotScope['coaching'],
      profile: profile(db, player.id, scope) as SnapshotScope['profile'],
    };
    note(`${scope}: ${patterns.length} patterns`);
  }

  return {
    version: SNAPSHOT_VERSION,
    generatedAt: Math.floor(Date.now() / 1000),
    engine: engineOf(games),
    analysisDepth: Number(getSetting(db, 'analysisDepth', process.env.ANALYSIS_DEPTH ?? '16')),
    minOccurrences: MIN_OCCURRENCES,
    player,
    games: games.map(stripPgn),
    moves,
    scopes,
  } as Snapshot;
}

/** The engine that actually produced the numbers, taken from the games rather than
 *  from whatever happens to be installed at export time. */
function engineOf(games: Array<{ engine: string | null }>): string {
  for (const game of games) if (game.engine) return game.engine;
  return 'unknown engine';
}

/**
 * Wraps the built web app around a snapshot to make one file that needs nothing:
 * no server, no network, no install. Open it and the leak sheet is there.
 *
 * Vite emits absolute /assets/... URLs, which resolve to the filesystem root under
 * file:// and fetch nothing. So the JS, the CSS and the icon all come inside, and
 * the manifest link — which has nothing to point at in a single file — goes away.
 */
export function inlineIntoHtml(
  templateHtml: string,
  snapshot: Snapshot,
  distDir: string,
  options: { plainFallback?: boolean } = {},
): string {
  let html = templateHtml;

  // Stylesheets first: <link href="/assets/x.css"> becomes the stylesheet itself.
  html = html.replace(
    /<link[^>]*rel="stylesheet"[^>]*href="\/(assets\/[^"]+\.css)"[^>]*>/g,
    (_match, href: string) => `<style>${readAsset(distDir, href)}</style>`,
  );

  // The bundle moves out of <head> and down to the end of <body>. Vite ships it as a
  // deferred module; inlined, it becomes a classic script, and a classic script in the
  // head runs before #root exists. It also has to come after the boot script, since it
  // reads the snapshot on its first tick.
  let bundle = '';
  html = html.replace(
    /<script[^>]*src="\/(assets\/[^"]+\.js)"[^>]*><\/script>\s*/g,
    (_match, src: string) => {
      bundle = readAsset(distDir, src);
      return '';
    },
  );

  // Fonts: the stylesheet comes in, and each woff2 it names becomes a data URI. This
  // design is carried by its typefaces, so a snapshot that has to fall back to a system
  // serif is not the thing that was designed.
  html = html.replace(
    /<link[^>]*rel="stylesheet"[^>]*href="\/(fonts\/fonts\.css)"[^>]*>/g,
    (_match, href: string) => `<style>${inlineFontUrls(distDir, readAsset(distDir, href))}</style>`,
  );

  // The icon can ride along as a data URI; the manifest cannot mean anything here.
  html = html
    .replace(/<link[^>]*rel="manifest"[^>]*>\s*/g, '')
    .replace(
      /<link([^>]*)href="\/(icon-192\.png)"([^>]*)>/g,
      (_match, before: string, file: string, after: string) =>
        `<link${before}href="data:image/png;base64,${readAssetBase64(distDir, file)}"${after}>`,
    );

  const tail = `${snapshotScripts(snapshot, options.plainFallback === true)}
<script>${bundle}</script>`;
  // A function replacer, not a string: minified JS is full of `$&` and `$\`` sequences,
  // and a string replacement would treat them as substitution patterns and corrupt the
  // bundle into something that no longer parses.
  return html.replace('</body>', () => `${tail}\n</body>`);
}

function snapshotScripts(snapshot: Snapshot, plainFallback: boolean): string {
  const json = JSON.stringify(snapshot);
  const packed = gzipSync(Buffer.from(json, 'utf8')).toString('base64');

  // Compressed, the payload is about a seventh of its size, and every browser that can
  // run this app has DecompressionStream. Carrying an uncompressed copy as well would
  // quadruple the file to insure against a browser nobody is using, so it is opt-in.
  const plain = plainFallback
    ? `<script id="leaksheet-plain" type="application/json">${escapeForScript(json)}</script>`
    : '';

  return `${plain}
<script id="leaksheet-data" type="application/octet-stream">${packed}</script>
<script>
(function () {
  function bytes(b64) {
    var bin = atob(b64), out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  window.__LEAKSHEET_BOOT__ = (async function () {
    var plain = document.getElementById('leaksheet-plain');
    try {
      if (typeof DecompressionStream === 'function') {
        var packed = document.getElementById('leaksheet-data').textContent.trim();
        var stream = new Blob([bytes(packed)]).stream()
          .pipeThrough(new DecompressionStream('gzip'));
        return JSON.parse(await new Response(stream).text());
      }
    } catch (err) {
      if (!plain) throw err;
    }
    if (plain) return JSON.parse(plain.textContent);
    throw new Error('This browser is too old to read a compressed snapshot.');
  })();
})();
</script>`;
}

/** Rewrites `url(/fonts/x.woff2)` to the font itself. */
function inlineFontUrls(distDir: string, css: string): string {
  return css.replace(/url\(\/(fonts\/[^)]+\.woff2)\)/g, (_match, file: string) => {
    const encoded = readAssetBase64(distDir, file);
    return `url(data:font/woff2;base64,${encoded})`;
  });
}

function readAsset(distDir: string, relative: string): string {
  return readFileSync(resolve(distDir, relative), 'utf8');
}

function readAssetBase64(distDir: string, relative: string): string {
  return readFileSync(resolve(distDir, relative)).toString('base64');
}

/** A literal `</script>` inside the JSON would close the tag early and break the page. */
function escapeForScript(json: string): string {
  return json.replace(/<\//g, '<\\/');
}

export function writeSnapshotFiles(
  snapshot: Snapshot,
  distDir: string,
  outDir: string,
  options: { plainFallback?: boolean } = {},
): { html: string; data: string } {
  const templateHtml = readFileSync(resolve(distDir, 'index.html'), 'utf8');
  const stamp = new Date(snapshot.generatedAt * 1000).toISOString().slice(0, 10);
  const slug = snapshot.player.username.toLowerCase().replace(/[^a-z0-9]+/g, '-');

  const htmlPath = resolve(outDir, `leaksheet-${slug}-${stamp}.html`);
  const dataPath = resolve(outDir, `${slug}-${stamp}.leaksheet.json.gz`);
  mkdirSync(dirname(htmlPath), { recursive: true });

  writeFileSync(htmlPath, inlineIntoHtml(templateHtml, snapshot, distDir, options));
  writeFileSync(dataPath, gzipSync(Buffer.from(JSON.stringify(snapshot), 'utf8')));
  return { html: htmlPath, data: dataPath };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const username = args.find((arg) => !arg.startsWith('--'));
  const withCoaching = args.includes('--coaching');
  const outDir = resolve(valueOf(args, '--out') ?? 'exports');
  const distDir = resolve(valueOf(args, '--dist') ?? '../web/dist');
  const plainFallback = args.includes('--with-fallback');

  const db = getDb();
  const name = username ?? firstPlayer(db);
  if (!name) throw new Error('No players in the database. Import some games first.');

  if (!existsSync(resolve(distDir, 'index.html'))) {
    throw new Error(`No built app at ${distDir}. Run "npm run build" first.`);
  }

  console.log(`Exporting ${name}…`);
  const snapshot = await buildSnapshot(db, name, {
    generateMissingCoaching: withCoaching,
    onProgress: (message) => console.log(`  ${message}`),
  });

  const { html, data } = writeSnapshotFiles(snapshot, distDir, outDir, { plainFallback });
  console.log(`\n  ${html}`);
  console.log(`  ${data}`);
  console.log('\nOpen the .html on any device. It needs no server and no network.');
  db.close();
}

function valueOf(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

function firstPlayer(db: DB): string | undefined {
  const row = db.prepare('SELECT username FROM players ORDER BY id LIMIT 1').get() as
    | { username: string }
    | undefined;
  return row?.username;
}

// Only run when invoked directly, so the functions above stay importable by tests.
if (process.argv[1]?.endsWith('export.ts') || process.argv[1]?.endsWith('export.js')) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
