/**
 * The move-sheet tabs are assembled from three files that have no compile-time link
 * to each other: a classification from `core`, a word and a glyph from `web/src/types`,
 * and a colour that exists only as a class name in `styles.css`. A verdict can gain a
 * tab and still render as grey, unlabelled, or literally `undefined`, and nothing in
 * the type checker notices — the lookups are all `Record<Classification, string>`,
 * which is satisfied by an empty string.
 *
 * So this is the seam the brilliant tab needed covering: every verdict that gets a tab
 * has to arrive with a word, a glyph and a colour that is really defined.
 */
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test, describe } from 'node:test';
import { GLYPH, VERDICT, type Classification } from '../../web/src/types.js';
import { glyphClass } from '../../web/src/format.js';

/** The verdicts the move sheet gives a tab of their own, worst to best. */
const TABBED: Classification[] = ['blunder', 'mistake', 'inaccuracy', 'brilliant'];

const STYLES = readFileSync(
  resolve(import.meta.dirname, '../../web/src/styles.css'),
  'utf8',
);

describe('the move-sheet tabs', () => {
  for (const verdict of TABBED) {
    test(`${verdict} has a word, a glyph and a colour`, () => {
      assert.ok(VERDICT[verdict], `no word for ${verdict}: the tab would read "undefined"`);
      assert.ok(GLYPH[verdict], `no glyph for ${verdict}`);

      const className = glyphClass(verdict);
      assert.ok(className, `no colour class for ${verdict}: the tab would render grey`);
      // A plain substring match would accept `.glyph-brilliantX` as proof that
      // `.glyph-brilliant` exists, which is how a rename slips through. The class
      // has to end where the selector ends.
      const defined = new RegExp(`\\.${className}(?![\\w-])`);
      assert.ok(
        defined.test(STYLES),
        `${className} is never defined in styles.css, so ${verdict} renders grey`,
      );
    });
  }

  test('brilliant is the one verdict on the good side of the scale', () => {
    // If this ever stops being true the tab order — worst to best — is wrong, and so
    // is the green: every other tabbed verdict is something that cost you something.
    assert.equal(GLYPH.brilliant, '!!');
    assert.equal(VERDICT.brilliant, 'Brilliant');
    assert.equal(glyphClass('brilliant'), 'glyph-brilliant');
  });

  test('the verdicts without a tab are the ones that are simply fine', () => {
    // best/excellent/good deliberately have no glyph and no tab: a filter that matched
    // most of the game would not be a filter. Adding a glyph to one of them without
    // adding its tab would put an annotation in the move list that nothing selects.
    for (const quiet of ['best', 'excellent', 'good'] as Classification[]) {
      assert.equal(GLYPH[quiet], '', `${quiet} has a glyph but no tab to filter it by`);
    }
  });
});
