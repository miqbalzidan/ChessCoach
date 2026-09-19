/**
 * Turning a snapshot into files on disk.
 *
 * Building the snapshot itself moved to `web/src/snapshot-build.ts`, because the
 * phone builds one too and cannot import anything from here. What is left is the
 * part that genuinely needs Node: gzip, the filesystem, and wrapping the built app
 * around the payload to make one self-contained HTML file.
 */
import { gzipSync } from 'node:zlib';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { Snapshot } from '../../web/src/types.js';
import { buildSnapshot } from '../../web/src/snapshot-build.js';
import { getDb, type DB } from './db-node.js';
import { generateCoaching } from './coach-claude.js';

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
  // The href carries whatever base the build used, so match the tail rather than the
  // whole path: an export built under a project page would otherwise not match here,
  // and the failure is silent — a snapshot in the wrong typeface, not an error.
  html = html.replace(
    /<link[^>]*rel="stylesheet"[^>]*href="[^"]*\/(fonts\/fonts\.css)"[^>]*>/g,
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

/**
 * Rewrites `url(./x.woff2)` to the font itself.
 *
 * The bare filename is what the stylesheet carries, because it is relative to its own
 * directory so that the site works under a project page as well as a domain root. The
 * older absolute `/fonts/x.woff2` is still accepted: an export is sometimes run against
 * a dist built before that change, and failing to inline a font is not a loud error —
 * it is a snapshot that quietly renders in Times New Roman.
 */
function inlineFontUrls(distDir: string, css: string): string {
  return css.replace(/url\((?:\.\/|\/fonts\/)([^)]+\.woff2)\)/g, (_match, file: string) => {
    const encoded = readAssetBase64(distDir, `fonts/${file.replace(/^fonts\//, '')}`);
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
    // Asking Claude is the server's to offer and stays opt-in: an export should not
    // quietly spend money, and the offline summariser is already good.
    generateCoaching: withCoaching ? generateCoaching : undefined,
    defaultDepth: process.env.ANALYSIS_DEPTH ?? '16',
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
