import { strict as assert } from 'node:assert';
import { test, describe } from 'node:test';
import {
  analysisBoardUrl,
  chesscomAnalysisUrl,
  LESSONS,
  lessonFor,
  motifsOf,
} from '../../web/src/links.js';
import { soundForSan } from '../../web/src/format.js';
import { MOTIF_LABELS } from '../../core/src/motifs.js';

describe('chesscomAnalysisUrl', () => {
  test('turns a game link into its analysis link', () => {
    assert.equal(
      chesscomAnalysisUrl('https://www.chess.com/game/live/123456789'),
      'https://www.chess.com/analysis/game/live/123456789?tab=analysis',
    );
    assert.equal(
      chesscomAnalysisUrl('https://chess.com/game/daily/42'),
      'https://www.chess.com/analysis/game/daily/42?tab=analysis',
    );
  });

  test('asks for the board, not Game Review', () => {
    // Game Review is Chess.com's own coached walkthrough: an animation, a paywall,
    // and a second opinion on the game this sheet has already explained.
    //
    // This only holds in a browser. On a phone the Chess.com app claims the link
    // before the page loads and routes by path, so `tab` never reaches anything that
    // reads it — which is what `analysisBoardUrl` exists to work around.
    const url = chesscomAnalysisUrl('https://www.chess.com/game/live/1');
    assert.ok(url && !url.includes('tab=review'), `still opens Game Review: ${url}`);
    assert.ok(url.includes('tab=analysis'));
  });

  test('offers nothing rather than a guess for anything else', () => {
    // A pasted PGN has no game to link to, and a lookalike host is not Chess.com.
    assert.equal(chesscomAnalysisUrl(null), null);
    assert.equal(chesscomAnalysisUrl(''), null);
    assert.equal(chesscomAnalysisUrl('https://lichess.org/abcd1234'), null);
    assert.equal(chesscomAnalysisUrl('https://notchess.com/game/live/1'), null);
    assert.equal(chesscomAnalysisUrl('https://www.chess.com/member/someone'), null);
  });
});

describe('analysisBoardUrl', () => {
  const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

  test('puts the position in the path, underscores for spaces', () => {
    // Lichess's documented scheme. Slashes stay slashes — percent-encoding them
    // gives a path the router does not recognise.
    assert.equal(
      analysisBoardUrl(START, 'white'),
      'https://lichess.org/analysis/standard/' +
        'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR_w_KQkq_-_0_1?color=white',
    );
  });

  test('opens the board from the side the player was on', () => {
    const url = analysisBoardUrl(START, 'black');
    assert.ok(url?.endsWith('?color=black'), url ?? 'no url');
  });

  test('goes nowhere the Chess.com app can intercept', () => {
    // The whole point: an App Link on chess.com is handed to the installed app,
    // which routes by path and opens Game Review whatever the query string says.
    // This link has to be on a host that app does not claim.
    const url = analysisBoardUrl(START);
    assert.ok(url && !/chess\.com/i.test(url), `back on chess.com: ${url}`);
  });

  test('a four-field FEN is enough; clocks are optional', () => {
    assert.ok(analysisBoardUrl('8/8/8/8/8/8/8/K6k w - -'));
  });

  test('offers nothing rather than a malformed URL', () => {
    assert.equal(analysisBoardUrl(null), null);
    assert.equal(analysisBoardUrl(''), null);
    assert.equal(analysisBoardUrl('not a fen'), null);
    // Seven ranks, not eight.
    assert.equal(analysisBoardUrl('8/8/8/8/8/8/K6k w - - 0 1'), null);
    // Nothing that could carry a query or a second path segment out of the FEN.
    assert.equal(analysisBoardUrl('8/8/8/8/8/8/8/K6k w - - 0 1?evil=1'), null);
  });
});

describe('lessons', () => {
  test('every motif the analysis can name has somewhere to go and read', () => {
    // Adding a motif without a lesson would silently leave the link off exactly the
    // pattern a player most needs to study.
    const missing = Object.keys(MOTIF_LABELS).filter((motif) => !lessonFor(motif));
    assert.deepEqual(missing, []);
  });

  test('no lesson points somewhere unusable', () => {
    for (const [motif, lesson] of Object.entries(LESSONS)) {
      assert.ok(lesson.url.startsWith('https://'), `${motif} is not https`);
      assert.ok(lesson.title.length > 0, `${motif} has no title`);
    }
  });

  test('an unknown motif simply has no lesson', () => {
    assert.equal(lessonFor('not-a-motif'), null);
    assert.equal(lessonFor(null), null);
  });
});

describe('motifsOf', () => {
  test('reads the stored comma-separated list', () => {
    assert.deepEqual(motifsOf('hung-piece,allowed-fork'), ['hung-piece', 'allowed-fork']);
    assert.deepEqual(motifsOf('hung-piece'), ['hung-piece']);
  });

  test('treats the empty column as no motifs', () => {
    assert.deepEqual(motifsOf(''), []);
    assert.deepEqual(motifsOf(null), []);
  });
});

describe('soundForSan', () => {
  test('a check is louder news than a capture', () => {
    // Bxf7+ is both; the check is the thing you want to hear.
    assert.equal(soundForSan('Bxf7+'), 'check');
    assert.equal(soundForSan('Qh7#'), 'check');
  });

  test('captures and quiet moves are told apart', () => {
    assert.equal(soundForSan('exd5'), 'capture');
    assert.equal(soundForSan('Nf3'), 'move');
    assert.equal(soundForSan('O-O'), 'move');
    assert.equal(soundForSan(undefined), 'move');
  });
});
