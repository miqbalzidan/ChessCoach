/**
 * The theme, the typefaces and the text size.
 *
 * Most of what can go wrong here passes every type check: a colour token added for
 * the light theme and forgotten in the dark one, a font size typed as plain pixels
 * that no longer follows the text-size setting, a typeface offered in Settings that
 * no stylesheet ever declares. Each renders something — just not what was chosen —
 * so these read the stylesheets the way the browser will.
 */
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, test } from 'node:test';
import {
  cssFor,
  DEFAULT_APPEARANCE,
  FONTS,
  sanitise,
  TEXT_SIZES,
  type FontRole,
} from '../../web/src/appearance.js';

const read = (path: string) => readFileSync(resolve(import.meta.dirname, '../../web', path), 'utf8');
const STYLES = read('src/styles.css');
const CORE_FONTS = read('public/fonts/fonts.css');
const EXTRA_FONTS = read('public/fonts/extra/extra.css');
const INDEX = read('index.html');

/** The custom properties a block declares, by name. */
function tokens(block: string): Map<string, string> {
  const found = new Map<string, string>();
  for (const match of block.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)) found.set(match[1]!, match[2]!.trim());
  return found;
}

function blockAfter(selector: string): string {
  const start = STYLES.indexOf(selector);
  assert.ok(start >= 0, `no ${selector} block`);
  return STYLES.slice(start, STYLES.indexOf('\n}', start));
}

describe('the dark theme', () => {
  const light = tokens(blockAfter(':root {'));
  const dark = tokens(blockAfter(":root[data-theme='dark'] {"));
  // These mean the board's own colours and the scale; they are the same at night.
  const FIXED = new Set(['--piece-white', '--piece-black', '--board-best', '--text-scale']);

  test('gives every colour token a dark value', () => {
    const colours = [...light].filter(([name, value]) => !FIXED.has(name) && /^(#|rgba?\()/.test(value));
    assert.ok(colours.length > 30, 'expected the full palette on :root');
    const missing = colours.map(([name]) => name).filter((name) => !dark.has(name));
    assert.deepEqual(missing, [], `no dark value for ${missing.join(', ')}`);
  });

  test('defines nothing the light theme does not', () => {
    const extra = [...dark.keys()].filter((name) => !light.has(name));
    assert.deepEqual(extra, []);
  });

  test('draws the pieces in their own colours, not the text colour', () => {
    // Ink turns light at night; a black piece drawn in ink would turn white with it.
    assert.match(blockAfter('.piece {'), /color: var\(--piece-black\)/);
    assert.match(blockAfter('.piece-white {'), /text-stroke: 1\.5px var\(--piece-black\)/);
  });

  test('is resolved before the first paint, and follows the system while open', () => {
    const boot = INDEX.slice(INDEX.indexOf('<script>'), INDEX.indexOf('</script>'));
    assert.ok(INDEX.indexOf('<script>') < INDEX.indexOf('fonts/fonts.css'), 'boot script must precede the styles');
    assert.match(boot, /localStorage\.getItem\('chesscoach\.appearance'\)/);
    assert.match(boot, /prefers-color-scheme: dark/);
    assert.match(boot, /addEventListener\('change', apply\)/);
  });
});

describe('text size', () => {
  test('every font size in the stylesheet follows the setting', () => {
    const bare = STYLES.split('\n')
      .map((line, index) => ({ line: line.trim(), number: index + 1 }))
      .filter(({ line }) => /^font(-size)?:/.test(line) && /\d(px|vw)/.test(line) && !line.includes('var(--text-scale)'));
    assert.deepEqual(bare, [], 'a font size that ignores the text-size setting');
  });

  test('the default is the designed size', () => {
    assert.equal(cssFor(DEFAULT_APPEARANCE)['--text-scale'], '1');
    assert.equal(TEXT_SIZES.find((size) => size.id === 'default')?.scale, 1);
  });
});

describe('typefaces', () => {
  const declared = (css: string) => new Set([...css.matchAll(/font-family: '([^']+)'/g)].map((m) => m[1]!));
  const core = declared(CORE_FONTS);
  const extra = declared(EXTRA_FONTS);

  test('every face offered is one a stylesheet declares, in the right one', () => {
    for (const role of Object.keys(FONTS) as FontRole[]) {
      for (const option of FONTS[role]) {
        const family = /^'([^']+)'/.exec(option.stack)?.[1];
        if (!family) continue; // a system option, which names no file of ours
        const home = option.extra ? extra : core;
        assert.ok(home.has(family), `${option.label} is offered but ${option.extra ? 'extra.css' : 'fonts.css'} does not declare '${family}'`);
      }
    }
  });

  test('every extra face falls back to a bundled one, then to the system', () => {
    // An exported file has no extra faces; it should land on the design, not a default serif.
    for (const role of Object.keys(FONTS) as FontRole[]) {
      for (const option of FONTS[role].filter((entry) => entry.extra)) {
        const families = option.stack.split(',').map((part) => part.trim().replace(/'/g, ''));
        assert.ok(families.slice(1).some((family) => core.has(family)), `${option.label} has no bundled fallback`);
        assert.match(option.stack, /(serif|sans-serif|monospace)$/);
      }
    }
  });

  test('the defaults are the designed faces, and the first option of each role', () => {
    for (const role of Object.keys(FONTS) as FontRole[]) {
      assert.equal(FONTS[role][0]!.id, DEFAULT_APPEARANCE[role]);
      assert.equal(FONTS[role][0]!.extra, undefined);
    }
  });
});

describe('a saved appearance', () => {
  test('keeps what it recognises and defaults the rest, one setting at a time', () => {
    assert.deepEqual(sanitise({ theme: 'dark', prose: 'literata', ui: 'comic-sans', size: 'huge' }), {
      ...DEFAULT_APPEARANCE,
      theme: 'dark',
      prose: 'literata',
    });
  });

  test('comes to the CSS the boot script applies', () => {
    const css = cssFor({ ...DEFAULT_APPEARANCE, mono: 'jetbrains', size: 'larger' });
    assert.match(css['--mono']!, /^'JetBrains Mono', 'IBM Plex Mono'/);
    assert.equal(css['--text-scale'], '1.25');
    // The boot script only accepts names of this shape, so nothing else could be set.
    for (const name of Object.keys(css)) assert.match(name, /^--[a-z-]+$/);
  });
});
