/**
 * Asking Claude for the coaching summary.
 *
 * Split out from the rest of the coaching layer because it is the only part that
 * needs an API key and a network. Everything it builds on — the brief, the schema,
 * the offline summariser it falls back to — is in core and runs anywhere.
 */
import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import {
  buildBrief,
  CoachingSchema,
  fallbackCoaching,
  now,
  offlineCoaching,
  SYSTEM_PROMPT,
  type Coaching,
  type CoachingInput,
} from '../../core/src/coach.js';

const MODEL = process.env.COACH_MODEL ?? 'claude-opus-5';

export function hasApiKey(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
}

export async function generateCoaching(input: CoachingInput): Promise<Coaching> {
  if (input.patterns.length === 0 || !hasApiKey()) return offlineCoaching(input);

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
