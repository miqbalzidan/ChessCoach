/**
 * Re-judge every analysed move against the current rules, without the engine.
 *
 * A verdict is a pure function of facts the database already holds — the two
 * evaluations, the move played, the engine's choice, and the positions either side.
 * None of that changes when the rules do, so a change to what counts as a blunder or
 * a brilliancy does not need Stockfish run over the archive again. It needs the same
 * numbers read once more.
 *
 * That matters because the alternative is not free: re-analysing 44 games at depth 16
 * is roughly twenty-five minutes on a desktop and an afternoon on a phone, and the
 * result would be identical to what this produces in about a second.
 *
 * Reporting is the default and writing is opt-in, because this rewrites a column in
 * a database the user cannot regenerate without that same afternoon.
 *
 *   npm run reclassify              # say what would change
 *   npm run reclassify -- --write   # change it
 */
import { classifyStoredMove } from '../../core/src/analysis.js';
import { getDb } from './db-node.js';
import type { DB } from '../../core/src/db.js';
import type { Classification } from '../../core/src/types.js';

interface StoredMove {
  id: number;
  fen_before: string;
  fen_after: string;
  uci: string;
  eval_before: number;
  eval_after: number;
  best_move_uci: string | null;
  classification: string;
}

/** Takes the database rather than opening one, so a test can hand it an empty one. */
export function reclassify(
  db: DB,
  write: boolean,
): { scanned: number; changes: Map<string, number> } {
  const moves = db
    .prepare(
      `SELECT id, fen_before, fen_after, uci, eval_before, eval_after, best_move_uci, classification
         FROM moves
        WHERE fen_before IS NOT NULL AND fen_after IS NOT NULL`,
    )
    .all() as StoredMove[];

  const update = db.prepare('UPDATE moves SET classification = @classification WHERE id = @id');
  const changes = new Map<string, number>();
  const pending: { id: number; classification: Classification }[] = [];

  for (const move of moves) {
    const verdict = classifyStoredMove({
      fenBefore: move.fen_before,
      fenAfter: move.fen_after,
      uci: move.uci,
      evalBefore: move.eval_before,
      evalAfter: move.eval_after,
      bestUci: move.best_move_uci,
    });
    if (verdict === move.classification) continue;

    const transition = `${move.classification} → ${verdict}`;
    changes.set(transition, (changes.get(transition) ?? 0) + 1);
    pending.push({ id: move.id, classification: verdict });
  }

  if (write && pending.length > 0) {
    // One transaction: a half-rewritten archive is worse than an un-rewritten one.
    db.transaction(() => {
      for (const row of pending) update.run(row);
    })();
  }

  return { scanned: moves.length, changes };
}

// Only when run as a command, so the function above stays importable by tests.
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop() ?? '\0')) {
  const write = process.argv.includes('--write');
  const { scanned, changes } = reclassify(getDb(), write);

  console.log(`Read ${scanned} analysed moves.`);
  if (changes.size === 0) {
    console.log('Every verdict already matches the current rules. Nothing to do.');
  } else {
    const total = [...changes.values()].reduce((sum, count) => sum + count, 0);
    console.log(`${write ? 'Rewrote' : 'Would rewrite'} ${total}:`);
    for (const [transition, count] of [...changes].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${String(count).padStart(5)}  ${transition}`);
    }
    if (!write) console.log('\nNothing was written. Re-run with --write to apply.');
  }
}
