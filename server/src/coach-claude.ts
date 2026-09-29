/**
 * Asking Claude for the coaching summary.
 *
 * Split out from the rest of the coaching layer because it is the only part that
 * needs Claude Code on this computer. Everything it builds on — the brief, the schema,
 * the offline summariser — is in core and runs anywhere.
 *
 * It throws `ClaudeUnavailable` rather than quietly writing the offline summary: this
 * only runs when someone asked for Claude, and "you got the other writer instead" is
 * something they should be told, with the reason, not left to notice.
 */
import {
  buildBrief,
  CoachingSchema,
  now,
  offlineCoaching,
  SYSTEM_PROMPT,
  type Coaching,
  type CoachingInput,
} from '../../core/src/coach.js';
import {
  buildGameBrief,
  GAME_REVIEW_PROMPT,
  GameReviewSchema,
  settleReview,
  type GameReviewBody,
} from '../../core/src/game-review.js';
import type { GameRow, MoveRow } from '../../core/src/store.js';
import type { Pattern } from '../../core/src/patterns.js';
import { askClaude } from './claude-code.js';

/**
 * Claude going over one game, after Stockfish has.
 *
 * The player's recurring patterns ride along so a mistake in this game can be named as
 * the habit it is, which is the difference between "you hung a knight" and "that is
 * the loose-piece leak again" — the second is the one that changes how you play.
 */
export async function generateGameReview(
  game: GameRow,
  moves: MoveRow[],
  patterns: Pattern[],
): Promise<GameReviewBody & { model: string; generatedAt: number }> {
  const { value, model } = await askClaude({
    system: GAME_REVIEW_PROMPT,
    prompt: `${buildGameBrief(game, moves, patterns)}\n\nGo over this game with the player.`,
    schema: GameReviewSchema,
  });
  return { ...settleReview(value, moves), model, generatedAt: now() };
}

export async function generateCoaching(input: CoachingInput): Promise<Coaching> {
  // Nothing to explain yet; no reason to spend any of the plan saying so.
  if (input.patterns.length === 0) return offlineCoaching(input);

  const { value, model } = await askClaude({
    system: SYSTEM_PROMPT,
    prompt: `${buildBrief(input)}\n\nWrite the coaching summary. Cover every pattern key listed above, in the same order.`,
    schema: CoachingSchema,
  });
  return { ...value, model, generatedAt: now() };
}
