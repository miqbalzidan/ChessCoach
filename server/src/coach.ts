import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import type { DB } from './db.js';
import type { Pattern } from './patterns.js';
import type { Scope } from './stats.js';
import type { dashboard } from './stats.js';

const MODEL = process.env.COACH_MODEL ?? 'claude-opus-5';

const CoachingSchema = z.object({
  headline: z
    .string()
    .describe('One sentence naming the single biggest recurring weakness, in plain language.'),
  diagnosis: z
    .string()
    .describe('Two or three sentences connecting the patterns into one explanation of what is going wrong.'),
  patterns: z.array(
    z.object({
      key: z.string().describe('The pattern key exactly as given in the brief.'),
      explanation: z
        .string()
        .describe('Two sentences on what the player is actually doing wrong and why it keeps happening.'),
      drill: z.string().describe('One concrete thing to practise this week.'),
    }),
  ),
  studyPlan: z
    .array(z.string())
    .describe('Three prioritised next steps, most valuable first.'),
});

export type Coaching = z.infer<typeof CoachingSchema> & { model: string; generatedAt: number };

const SYSTEM_PROMPT = `You are a chess coach reviewing one player's analysed game history.

You are given aggregate statistics and mistake patterns that were detected by an engine,
not by you. Treat every number in the brief as fact and never invent new ones.

Write the way a good coach talks to a student: direct, specific, no hedging, no praise
padding. Name the mechanism behind a mistake rather than restating that it happened.
The player already knows they blunder — tell them what the blunders have in common.

Never recommend a specific opening repertoire change unless the brief's opening data
supports it. Prefer advice the player can act on this week.`;

export interface CoachingInput {
  username: string;
  scope: Scope;
  stats: ReturnType<typeof dashboard>;
  patterns: Pattern[];
}

export function hasApiKey(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
}

/**
 * Turns the numbers into a brief. Keeping this separate from the request makes the
 * exact text the model sees reviewable, and it is also what the offline fallback
 * renders from.
 */
export function buildBrief(input: CoachingInput): string {
  const { stats, patterns, scope } = input;
  const head = stats.headline;
  const lines: string[] = [];

  lines.push(`Player: ${input.username}`);
  lines.push(`Segment: ${scope === 'all' ? 'all time controls' : scope}`);
  lines.push(
    `Sample: ${head.analysedGames} analysed games (${head.record.win}W/${head.record.loss}L/${head.record.draw}D, ${head.winRate}% win rate), ${head.moves} of their own moves.`,
  );
  lines.push(
    `Accuracy ${head.accuracy}%${head.accuracyDelta === null ? '' : ` (${signed(head.accuracyDelta)} vs the previous 30 days)`}; median loss per move ${head.medianCentipawnLoss} centipawns.`,
  );
  lines.push(
    `Blunders per game ${head.blundersPerGame}${head.blundersPerGameDelta === null ? '' : ` (${signed(head.blundersPerGameDelta)} vs the previous 30 days)`}.`,
  );

  lines.push('');
  lines.push('Mistakes by phase (share of all their mistakes, and mistakes per 100 moves played in that phase):');
  for (const phase of stats.phases) {
    lines.push(`  ${phase.phase}: ${phase.share}% of mistakes, ${phase.rate} per 100 moves`);
  }

  const clockBuckets = stats.clock.buckets.filter((b) => b.moves > 0);
  if (clockBuckets.length > 0) {
    lines.push('');
    lines.push(`Blunder rate by time remaining (clock data covers ${stats.clock.coverage}% of moves):`);
    for (const bucket of clockBuckets) {
      lines.push(
        `  ${bucket.label}: ${bucket.rate} blunders per 100 moves (${bucket.multiplier}x the >60s rate), ${bucket.moves} moves`,
      );
    }
  }

  if (stats.timeClasses.some((t) => t.analysed > 0)) {
    lines.push('');
    lines.push('By time class:');
    for (const tc of stats.timeClasses) {
      if (tc.analysed === 0) continue;
      lines.push(
        `  ${tc.timeClass}: ${tc.analysed} games, accuracy ${tc.accuracy}%, ${tc.blundersPerGame} blunders/game, ${tc.winRate}% win rate`,
      );
    }
  }

  const weakOpenings = stats.openings.filter((o) => o.games >= 3).slice(0, 5);
  if (weakOpenings.length > 0) {
    lines.push('');
    lines.push('Most played openings (ECO, as which colour, win rate):');
    for (const opening of weakOpenings) {
      lines.push(
        `  ${opening.eco} ${opening.name} as ${opening.color}: ${opening.games} games, ${opening.winRate}% win rate, accuracy ${opening.accuracy}%`,
      );
    }
  }

  lines.push('');
  lines.push('Detected mistake patterns, worst first. Use these keys verbatim:');
  for (const pattern of patterns) {
    const clock =
      pattern.timeScrambleShare === null
        ? ''
        : `, ${pattern.timeScrambleShare}% played with under 20 seconds left`;
    lines.push(
      `  key=${pattern.key} — "${pattern.title}": ${pattern.occurrences} occurrences across ${pattern.gamesAffected} games ` +
        `(${pattern.blunders} blunders, ${pattern.mistakes} mistakes, ${pattern.inaccuracies} inaccuracies), ` +
        `mostly in the ${pattern.phase} (${pattern.phaseShare}%), in ${listPhrase(pattern.timeClasses)}, ` +
        `costing an estimated ${pattern.eloCost} rating points${clock}.`,
    );
    const example = pattern.examples[0];
    if (example) {
      lines.push(
        `      example: move ${example.moveNumber} ${example.san} instead of ${example.bestMoveSan ?? 'the engine move'} ` +
          `(lost ${example.winPercentLoss}% winning chances)`,
      );
    }
  }

  return lines.join('\n');
}

function signed(value: number): string {
  return value > 0 ? `+${value}` : String(value);
}

export function listPhrase(items: string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

export async function generateCoaching(input: CoachingInput): Promise<Coaching> {
  if (input.patterns.length === 0) {
    return { ...emptyCoaching(), model: 'none', generatedAt: now() };
  }
  if (!hasApiKey()) {
    return { ...fallbackCoaching(input), model: 'offline', generatedAt: now() };
  }

  const client = new Anthropic();
  const brief = buildBrief(input);

  try {
    const response = await client.messages.parse({
      model: MODEL,
      max_tokens: 16000,
      system: SYSTEM_PROMPT,
      thinking: { type: 'adaptive' },
      output_config: { format: zodOutputFormat(CoachingSchema) },
      messages: [
        {
          role: 'user',
          content: `${brief}\n\nWrite the coaching summary. Cover every pattern key listed above, in the same order.`,
        },
      ],
    });

    const parsed = response.parsed_output;
    if (!parsed) return { ...fallbackCoaching(input), model: 'offline', generatedAt: now() };
    return { ...parsed, model: response.model, generatedAt: now() };
  } catch (error) {
    // Coaching is a layer on top of the analysis, never a prerequisite for it, so a
    // failed call degrades to the deterministic summary instead of failing the page.
    if (error instanceof Anthropic.AuthenticationError) {
      return { ...fallbackCoaching(input), model: 'offline (invalid API key)', generatedAt: now() };
    }
    if (error instanceof Anthropic.RateLimitError) {
      return { ...fallbackCoaching(input), model: 'offline (rate limited)', generatedAt: now() };
    }
    if (error instanceof Anthropic.APIError) {
      return {
        ...fallbackCoaching(input),
        model: `offline (API error ${error.status})`,
        generatedAt: now(),
      };
    }
    throw error;
  }
}

function emptyCoaching(): z.infer<typeof CoachingSchema> {
  return {
    headline: 'Not enough analysed games yet to find a repeating pattern.',
    diagnosis:
      'Import and analyse more games — patterns need at least a handful of repeats before they mean anything.',
    patterns: [],
    studyPlan: [],
  };
}

/**
 * The deterministic summary. It says less than the model would, but everything it
 * says is read straight off the same numbers, so the product still works without
 * an API key.
 */
export function fallbackCoaching(input: CoachingInput): z.infer<typeof CoachingSchema> {
  const { patterns, stats } = input;
  const worst = patterns[0]!;
  const clock = stats.clock.buckets.find((b) => b.label === '<20s');
  const phase = [...stats.phases].sort((a, b) => b.share - a.share)[0];

  const headline = `${worst.title.toLowerCase()} — ${worst.occurrences} times across ${worst.gamesAffected} games, costing roughly ${worst.eloCost} rating points.`;

  const diagnosisParts = [
    `Your mistakes concentrate in the ${phase?.phase ?? 'middlegame'} (${phase?.share ?? 0}% of them).`,
  ];
  if (clock && clock.multiplier > 1.5) {
    diagnosisParts.push(
      `Under 20 seconds your blunder rate is ${clock.multiplier}× what it is above a minute, so part of this is clock management rather than knowledge.`,
    );
  }
  if (patterns.length > 1) {
    diagnosisParts.push(
      `The next most expensive pattern is ${patterns[1]!.title.toLowerCase()} (${patterns[1]!.occurrences} times).`,
    );
  }

  return {
    headline,
    diagnosis: diagnosisParts.join(' '),
    // The occurrence counts already sit next to this text in the UI, so the
    // explanation says what is going wrong rather than repeating them.
    patterns: patterns.map((pattern) => ({
      key: pattern.key,
      explanation: pattern.mechanism,
      drill: pattern.suggestion,
    })),
    studyPlan: patterns.slice(0, 3).map((pattern) => pattern.suggestion),
  };
}

function now(): number {
  return Math.floor(Date.now() / 1000);
}

export function readCachedCoaching(db: DB, playerId: number, scope: Scope): Coaching | null {
  const row = db
    .prepare('SELECT body, model, created_at FROM coaching WHERE player_id = ? AND scope = ?')
    .get(playerId, scope) as { body: string; model: string; created_at: number } | undefined;
  if (!row) return null;
  try {
    return { ...JSON.parse(row.body), model: row.model, generatedAt: row.created_at };
  } catch {
    return null;
  }
}

export function writeCachedCoaching(
  db: DB,
  playerId: number,
  scope: Scope,
  coaching: Coaching,
): void {
  db.prepare(
    `INSERT INTO coaching (player_id, scope, body, model, created_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (player_id, scope) DO UPDATE SET
       body = excluded.body, model = excluded.model, created_at = excluded.created_at`,
  ).run(
    playerId,
    scope,
    JSON.stringify({
      headline: coaching.headline,
      diagnosis: coaching.diagnosis,
      patterns: coaching.patterns,
      studyPlan: coaching.studyPlan,
    }),
    coaching.model,
    coaching.generatedAt,
  );
}
