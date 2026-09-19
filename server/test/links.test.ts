import { strict as assert } from 'node:assert';
import { test, describe } from 'node:test';
import { chesscomAnalysisUrl, LESSONS, lessonFor, motifsOf } from '../../web/src/links.js';
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

  test('opens the board, not Game Review', () => {
    // Game Review is Chess.com's own coached walkthrough: an animation, a paywall,
    // and a second opinion on the game this sheet has already explained. Following
    // a leak should land on a board you can push pieces around on.
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
