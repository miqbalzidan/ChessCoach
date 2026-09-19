import { strict as assert } from 'node:assert';
import { gunzipSync } from 'node:zlib';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { test, describe } from 'node:test';
import Database from 'better-sqlite3';
import { buildSnapshot, inlineIntoHtml } from '../src/export.js';
import { migrate, type DB } from '../../core/src/db.js';
import { openings } from '../../core/src/stats.js';
import { lensKey, SNAPSHOT_VERSION, type Scope, type Snapshot } from '../../web/src/types.js';

const SCOPES: Scope[] = ['all', 'bullet', 'blitz', 'rapid', 'daily'];

const TEMPLATE = `<!doctype html><html><head>
<link rel="stylesheet" crossorigin href="/assets/app.css">
<link rel="stylesheet" href="/fonts/fonts.css" />
<link rel="manifest" href="/manifest.webmanifest" />
<script type="module" crossorigin src="/assets/app.js"></script>
</head><body><div id="root"></div></body></html>`;

/** The same document as served from a project page, where every href carries a base. */
const TEMPLATE_UNDER_SUBPATH = TEMPLATE.replace(/href="\/|src="\//g, (m) =>
  m.replace('"/', '"/ChessCoach/'),
);

function fixtureDist(bundle: string): string {
  const dir = mkdtempSync(resolve(tmpdir(), 'leaksheet-'));
  mkdirSync(resolve(dir, 'assets'), { recursive: true });
  writeFileSync(resolve(dir, 'assets/app.js'), bundle);
  writeFileSync(resolve(dir, 'assets/app.css'), '.sheet{background:#e8e2d4}');
  // Fonts, because this design is carried by them: a snapshot that silently falls
  // back to a system serif is not the thing that was designed, and nothing else in
  // these tests would notice.
  mkdirSync(resolve(dir, 'fonts'), { recursive: true });
  writeFileSync(resolve(dir, 'fonts/bodoni.woff2'), Buffer.from('woff2-bytes'));
  writeFileSync(
    resolve(dir, 'fonts/fonts.css'),
    "@font-face{font-family:'Bodoni Moda';src:url(./bodoni.woff2) format('woff2');}",
  );
  return dir;
}

function fixtureSnapshot(): Snapshot {
  return {
    version: SNAPSHOT_VERSION,
    generatedAt: 1_700_000_000,
    engine: 'Stockfish 16',
    analysisDepth: 16,
    minOccurrences: 3,
    player: {
      id: 1,
      username: 'tester',
      source: 'chess.com',
      created_at: 1,
      last_synced_at: 2,
    },
    games: [],
    moves: {},
    lenses: {},
  };
}

describe('snapshot inlining', () => {
  test('a bundle containing $ patterns survives intact', () => {
    // String.replace treats $&, $` and $' as substitution patterns, and minified JS is
    // full of them. Getting this wrong produced an HTML file that loaded, showed the
    // background, and failed with a bare SyntaxError — so it is worth a test.
    const bundle = "var a='$&';var b=\"$`\";var c='$\\'';var d=`$$`;console.log(a,b,c,d);";
    const html = inlineIntoHtml(TEMPLATE, fixtureSnapshot(), fixtureDist(bundle));
    assert.ok(html.includes(bundle), 'bundle was rewritten by replacement patterns');
    assert.ok(!html.includes('</body>var'), 'replacement leaked the match into the bundle');
  });

  test('the bundle runs after #root rather than in the head', () => {
    const html = inlineIntoHtml(TEMPLATE, fixtureSnapshot(), fixtureDist('var x=1;'));
    // An inline classic script in <head> executes before #root exists, so the app
    // cannot mount. Order is the whole difference between working and blank.
    assert.ok(html.indexOf('<div id="root">') < html.indexOf('var x=1;'));
    assert.ok(!/<script[^>]*src="\/assets/.test(html), 'left an unresolved asset reference');
  });

  test('nothing is left pointing at the network or the filesystem root', () => {
    const html = inlineIntoHtml(TEMPLATE, fixtureSnapshot(), fixtureDist('var x=1;'));
    assert.ok(!html.includes('href="/assets'), 'stylesheet still external');
    assert.ok(!html.includes('rel="manifest"'), 'manifest link cannot resolve in one file');
    assert.ok(html.includes('.sheet{background:#e8e2d4}'), 'stylesheet was not inlined');
  });

  test('the typefaces travel with the file', () => {
    const html = inlineIntoHtml(TEMPLATE, fixtureSnapshot(), fixtureDist('var x=1;'));
    assert.ok(html.includes('data:font/woff2;base64,'), 'font was not inlined');
    assert.ok(!html.includes('fonts.css'), 'stylesheet still fetched over the network');
    assert.ok(!/url\(\.?\/?[^)]*\.woff2\)/.test(html), 'a woff2 is still a file reference');
  });

  test('an export built for a project page still inlines its fonts', () => {
    // The href carries the base when the site is built for /<repo>/. Matching the
    // whole absolute path would miss it here, and the failure is silent: a snapshot
    // in Times New Roman rather than an error anybody would see.
    const html = inlineIntoHtml(TEMPLATE_UNDER_SUBPATH, fixtureSnapshot(), fixtureDist('var x=1;'));
    assert.ok(html.includes('data:font/woff2;base64,'), 'font was not inlined under a base path');
  });

  test('the payload round-trips through gzip and base64', () => {
    const snapshot = fixtureSnapshot();
    const html = inlineIntoHtml(TEMPLATE, snapshot, fixtureDist('var x=1;'));
    const packed = /id="leaksheet-data"[^>]*>([^<]+)</.exec(html)?.[1];
    assert.ok(packed, 'no payload found');
    const decoded = JSON.parse(gunzipSync(Buffer.from(packed.trim(), 'base64')).toString());
    assert.equal(decoded.player.username, 'tester');
    assert.equal(decoded.engine, 'Stockfish 16');
  });

  test('a plain fallback is opt-in, because it quadruples the file', () => {
    const dist = fixtureDist('var x=1;');
    const lean = inlineIntoHtml(TEMPLATE, fixtureSnapshot(), dist);
    const fat = inlineIntoHtml(TEMPLATE, fixtureSnapshot(), dist, { plainFallback: true });
    // The boot script names the element either way, so look for the element itself.
    const hasPlainBlock = (html: string) => html.includes('<script id="leaksheet-plain"');
    assert.ok(!hasPlainBlock(lean), 'lean export carried the uncompressed copy');
    assert.ok(hasPlainBlock(fat), '--with-fallback did not add the uncompressed copy');
    assert.ok(fat.length > lean.length);
  });
});


/** A player whose openings do not line up neatly across the time classes, which is
 *  where the exporter's completeness rule earns its keep. */
function seededDb(): DB {
  const db = new Database(':memory:');
  migrate(db);
  db.prepare(
    `INSERT INTO players (id, username, source, created_at) VALUES (1, 'tester', 'test', 0)`,
  ).run();

  const rows: Array<[string, string, string]> = [
    // eco, colour, time class — the Berlin is mostly rapid, the Sicilian mostly blitz.
    ['C65', 'white', 'rapid'],
    ['C65', 'white', 'rapid'],
    ['C65', 'white', 'rapid'],
    ['C65', 'white', 'blitz'],
    ['B20', 'black', 'blitz'],
    ['B20', 'black', 'blitz'],
    ['B20', 'black', 'bullet'],
    ['A04', 'white', 'daily'],
    ['A04', 'white', 'daily'],
  ];

  rows.forEach(([eco, color, timeClass], index) => {
    db.prepare(
      `INSERT INTO games (id, player_id, external_id, source, pgn, time_class, time_control,
                          end_time, white_username, black_username, eco, eco_name, player_color,
                          result, opponent, move_count, accuracy_white, accuracy_black,
                          analysed_at, created_at)
       VALUES (@id, 1, @ext, 'test', '', @timeClass, '600+0', @endTime, 'tester', 'other',
               @eco, @eco, @color, 'win', 'other', 10, 80, 80, 1, 0)`,
    ).run({
      id: index + 1,
      ext: `g${index + 1}`,
      timeClass,
      endTime: 1_000_000 + index,
      eco,
      color,
    });
  });
  return db;
}

describe('which lenses a snapshot carries', () => {
  test('every opening the reader can offer exists in every time class', async () => {
    // An opening picked under one time class stays picked when you switch to
    // another. If that combination was never written, the phone shows a screen with
    // no numbers and no way back — so the exporter writes the product, not the
    // diagonal, and this is the assertion that keeps it doing so.
    const db = seededDb();
    const snapshot = await buildSnapshot(db, 'tester');

    const menu = new Set<string>();
    for (const scope of SCOPES) {
      for (const row of openings(db, 1, { scope })) menu.add(`${row.eco}:${row.color}`);
    }
    assert.ok(menu.size >= 3, 'fixture should offer several openings');

    const missing: string[] = [];
    for (const scope of SCOPES) {
      if (!snapshot.lenses[scope]) missing.push(scope);
      for (const entry of menu) {
        const [eco, color] = entry.split(':');
        const key = lensKey({ scope, eco, color: color as 'white' | 'black' });
        if (!snapshot.lenses[key]) missing.push(key);
      }
    }
    assert.deepEqual(missing, []);
    db.close();
  });

  test('an unfiltered lens is still keyed by its bare time class', async () => {
    // Which is what makes a snapshot readable by a client that knows only scopes.
    const db = seededDb();
    const snapshot = await buildSnapshot(db, 'tester');
    for (const scope of SCOPES) assert.ok(snapshot.lenses[scope], `no ${scope} lens`);
    assert.equal(snapshot.lenses.all!.dashboard.lens.eco, undefined);
    db.close();
  });
});

/**
 * The guard for the bug that shipped: `fonts.css` lives in `public/`, which Vite copies
 * verbatim rather than processing, so nothing rewrites the URLs inside it for the base
 * path. Root-absolute ones work perfectly everywhere this was tested — a dev server, a
 * preview, an exported file — and then 404 on a project page, where the app quietly
 * renders in a system serif instead of the typefaces it is built around.
 *
 * Asserted against the real stylesheet rather than a fixture, because the real one is
 * what ships and the generator that writes it is the thing that regressed.
 */
describe('fonts survive being served from a subdirectory', () => {
  const stylesheet = readFileSync(
    resolve(import.meta.dirname, '../../web/public/fonts/fonts.css'),
    'utf8',
  );

  test('no url() in the stylesheet is root-absolute', () => {
    const absolute = [...stylesheet.matchAll(/url\((\/[^)]*)\)/g)].map((m) => m[1]);
    assert.deepEqual(
      absolute,
      [],
      `these resolve against the domain root, so they 404 under /<repo>/: ${absolute.join(', ')}`,
    );
  });

  test('every font it names sits beside it', () => {
    const referenced = [...stylesheet.matchAll(/url\(\.\/([^)]+\.woff2)\)/g)].flatMap((m) =>
      m[1] ? [m[1]] : [],
    );
    assert.ok(referenced.length > 0, 'no fonts referenced at all');
    for (const file of new Set(referenced)) {
      const path = resolve(import.meta.dirname, '../../web/public/fonts', file);
      assert.ok(existsSync(path), `fonts.css names ${file}, which is not there`);
    }
  });
});
