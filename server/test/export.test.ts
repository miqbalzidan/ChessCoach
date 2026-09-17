import { strict as assert } from 'node:assert';
import { gunzipSync } from 'node:zlib';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { test, describe } from 'node:test';
import { inlineIntoHtml } from '../src/export.js';
import type { Snapshot } from '../../web/src/types.js';

const TEMPLATE = `<!doctype html><html><head>
<link rel="stylesheet" crossorigin href="/assets/app.css">
<link rel="manifest" href="/manifest.webmanifest" />
<script type="module" crossorigin src="/assets/app.js"></script>
</head><body><div id="root"></div></body></html>`;

function fixtureDist(bundle: string): string {
  const dir = mkdtempSync(resolve(tmpdir(), 'leaksheet-'));
  mkdirSync(resolve(dir, 'assets'), { recursive: true });
  writeFileSync(resolve(dir, 'assets/app.js'), bundle);
  writeFileSync(resolve(dir, 'assets/app.css'), '.sheet{background:#e8e2d4}');
  return dir;
}

function fixtureSnapshot(): Snapshot {
  return {
    version: 1,
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
    scopes: {} as Snapshot['scopes'],
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
