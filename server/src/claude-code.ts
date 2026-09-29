/**
 * Asking Claude, through the Claude Code on this computer.
 *
 * Claude Code comes with a Pro or Max plan, so running it as a subprocess spends the
 * plan's own allowance — the same one chatting on claude.ai draws from — and nothing
 * else. No API key, no Console account, no second bill. It is the documented way to
 * script Claude Code (`claude -p`), and it is personal use of your own login on your
 * own machine: this app is not a service that signs other people in.
 *
 * Every call is sealed off from the machine it runs on. Claude is asked to read a
 * brief and answer in a fixed shape, so it gets no tools at all, no settings or
 * hooks from this project or your home directory, no MCP servers, and a scratch
 * directory as its working directory. A chess summary has no business touching
 * your files, and this makes sure it cannot.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';

/** The executable. Set CLAUDE_PATH when `claude` is not on the PATH the server sees. */
const CLAUDE = process.env.CLAUDE_PATH || 'claude';

/**
 * Left unset, Claude Code uses its own default for your plan, which is the model the
 * plan is sure to have. COACH_MODEL takes any name `claude --model` accepts.
 */
const MODEL = process.env.COACH_MODEL || undefined;

/**
 * How hard Claude thinks before it writes: low, medium, high, xhigh or max, or empty
 * for Claude Code's own default. High by default, because it was measured to matter:
 * on the same game at Claude Code's default, Claude narrated a queen capture the
 * opponent never played, and at high it described the position it was actually
 * given — for sixteen seconds instead of ten, and somewhat more of the plan per run.
 */
const EFFORT = process.env.COACH_EFFORT ?? 'high';

/** A reading of a whole game can take a minute; nothing reasonable takes five. */
const TIMEOUT_MS = Number(process.env.COACH_TIMEOUT_MS ?? 5 * 60_000);

/**
 * Claude could not be asked, and why — written for the person reading the page, since
 * that is where it ends up. Carrying a reason rather than a bare failure is the whole
 * point: "not installed", "not logged in" and "out of usage for now" each have a
 * different fix, and only the person can apply it.
 */
export class ClaudeUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ClaudeUnavailable';
  }
}

export interface ClaudeAnswer<T> {
  value: T;
  /** The model that actually answered, as Claude Code reports it. */
  model: string;
}

export async function askClaude<T>(request: {
  system: string;
  prompt: string;
  schema: z.ZodType<T>;
}): Promise<ClaudeAnswer<T>> {
  const args = [
    '-p',
    '--output-format',
    'json',
    '--json-schema',
    schemaArgument(request.schema),
    '--system-prompt',
    request.system,
    // No tools, no settings files, no MCP servers, no skills, no saved session.
    '--tools',
    '',
    '--restricted',
    '--strict-mcp-config',
    '--disable-slash-commands',
    '--no-session-persistence',
  ];
  if (MODEL) args.push('--model', MODEL);
  if (EFFORT) args.push('--effort', EFFORT);

  const { stdout, stderr, code } = await run(args, request.prompt);
  return readResult(stdout, request.schema, { stderr, code });
}

/**
 * The answer's shape, as `--json-schema` will accept it.
 *
 * Zod stamps its output with the 2020-12 meta-schema URI, which Claude Code's
 * validator does not know and refuses outright. Nothing these schemas use differs
 * between drafts, so the stamp is simply left off.
 */
export function schemaArgument(schema: z.ZodType): string {
  const { $schema: _stamp, ...body } = z.toJSONSchema(schema, { target: 'draft-7' }) as Record<string, unknown>;
  return JSON.stringify(body);
}

/**
 * Turns Claude Code's JSON result into an answer, or into the reason there is none.
 *
 * Separate from the process handling so it can be tested against real output without
 * spending anything. When a run fails inside Claude Code — not logged in, usage used
 * up — the failure arrives as the result text with `is_error` set, not on stderr.
 */
export function readResult<T>(
  stdout: string,
  schema: z.ZodType<T>,
  context: { stderr?: string; code?: number | null } = {},
): ClaudeAnswer<T> {
  let output: {
    is_error?: boolean;
    result?: unknown;
    structured_output?: unknown;
    modelUsage?: Record<string, { outputTokens?: number }>;
  };
  try {
    output = JSON.parse(stdout);
  } catch {
    const detail = (context.stderr || stdout).trim().split('\n').slice(-3).join(' ');
    throw new ClaudeUnavailable(
      `Claude Code did not answer${context.code ? ` (exit ${context.code})` : ''}${detail ? `: ${detail}` : '.'}`,
    );
  }

  if (output.is_error) {
    throw new ClaudeUnavailable(`Claude Code: ${String(output.result ?? 'the request failed').trim()}`);
  }

  const parsed = schema.safeParse(output.structured_output);
  if (!parsed.success) {
    throw new ClaudeUnavailable('Claude answered, but not in the shape this page reads. Try again.');
  }

  return { value: parsed.data, model: mainModel(output.modelUsage) };
}

/**
 * The model that did the writing.
 *
 * Claude Code can use a small model for housekeeping in the same run, so the usage
 * map may name two. The one that wrote the most is the one that wrote the answer.
 */
export function mainModel(usage: Record<string, { outputTokens?: number }> | undefined): string {
  let best = 'claude';
  let most = -1;
  for (const [model, entry] of Object.entries(usage ?? {})) {
    const tokens = entry.outputTokens ?? 0;
    if (tokens > most) {
      best = model;
      most = tokens;
    }
  }
  return best;
}

export interface ClaudeStatus {
  available: boolean;
  /** Why not, in words for the settings page. */
  reason?: string;
}

let statusCache: { at: number; value: ClaudeStatus } | null = null;

/**
 * Whether asking would work, without asking — `claude auth status` costs nothing.
 *
 * Cached briefly rather than for the life of the server, so logging in while the app
 * is open is noticed on the next page load instead of needing a restart.
 */
export async function claudeStatus(): Promise<ClaudeStatus> {
  if (statusCache && Date.now() - statusCache.at < 30_000) return statusCache.value;

  let value: ClaudeStatus;
  try {
    const { stdout } = await run(['auth', 'status', '--json'], '', 15_000);
    let loggedIn = true;
    try {
      loggedIn = (JSON.parse(stdout) as { loggedIn?: boolean }).loggedIn !== false;
    } catch {
      // A version that cannot report its login still answers when asked for real,
      // and that answer carries its own reason if it fails. Better than refusing.
    }
    value = loggedIn
      ? { available: true }
      : {
          available: false,
          reason:
            'Claude Code is installed but not logged in. Run `claude` once in a terminal and sign in with your Claude account.',
        };
  } catch (error) {
    value = { available: false, reason: error instanceof Error ? error.message : String(error) };
  }

  statusCache = { at: Date.now(), value };
  return value;
}

/**
 * The last known answer, without waiting for a fresh one — for places that must stay
 * fast, like the health check every page load starts with. Starts a refresh when the
 * answer is missing or old, so the next caller gets a current one.
 */
export function peekClaudeStatus(): ClaudeStatus | null {
  if (!statusCache || Date.now() - statusCache.at >= 30_000) void claudeStatus();
  return statusCache?.value ?? null;
}

function run(
  args: string[],
  input: string,
  timeoutMs = TIMEOUT_MS,
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  // A scratch directory, so no CLAUDE.md or project settings are picked up from
  // wherever the server happens to have been started.
  const cwd = mkdtempSync(join(tmpdir(), 'chesscoach-claude-'));

  // Only your plan pays for this. Claude Code prefers an API key over its own login
  // when one is in the environment, so any key exported for something else is left
  // out rather than quietly billed.
  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;

  return new Promise((resolve, reject) => {
    const cleanup = () => rmSync(cwd, { recursive: true, force: true });
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(CLAUDE, args, { cwd, env });
    } catch (error) {
      cleanup();
      reject(notInstalled(error));
      return;
    }

    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk));

    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      cleanup();
      reject(new ClaudeUnavailable(`Claude Code took longer than ${Math.round(timeoutMs / 1000)}s and was stopped.`));
    }, timeoutMs);

    child.on('error', (error) => {
      clearTimeout(timer);
      cleanup();
      reject(notInstalled(error));
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      cleanup();
      resolve({ stdout, stderr, code });
    });

    child.stdin.on('error', () => {
      // A process that exits before reading its input closes the pipe; the exit
      // itself is what gets reported.
    });
    child.stdin.end(input);
  });
}

function notInstalled(error: unknown): ClaudeUnavailable {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (code === 'ENOENT' || code === 'EINVAL') {
    return new ClaudeUnavailable(
      `Claude Code was not found (looked for \`${CLAUDE}\`). Install it from claude.com/code and sign in with your Claude account, or set CLAUDE_PATH to where it is installed.`,
    );
  }
  return new ClaudeUnavailable(`Could not start Claude Code: ${error instanceof Error ? error.message : String(error)}`);
}
