import { Chess } from 'chess.js';
import { getDb } from './db.js';
import { EnginePool } from './engine.js';
import { analysePending } from './importer.js';
import { createJob } from './importer.js';
import { insertGame, upsertPlayer } from './store.js';
import { applyUci } from './motifs.js';
import type { ImportedGame, TimeClass } from './types.js';

/**
 * Generates a demo history by having Stockfish play against a deliberately
 * imperfect opponent. It exists because the Chess.com API is not always reachable
 * (corporate networks, offline work, this project's own CI) and because the
 * dashboard is meaningless until there is a body of games with real mistakes in it.
 */

interface OpeningLine {
  eco: string;
  name: string;
  moves: string[];
}

const OPENINGS: OpeningLine[] = [
  { eco: 'B90', name: 'Sicilian Defense Najdorf Variation', moves: ['e4', 'c5', 'Nf3', 'd6', 'd4', 'cxd4', 'Nxd4', 'Nf6', 'Nc3', 'a6'] },
  { eco: 'B20', name: 'Sicilian Defense', moves: ['e4', 'c5'] },
  { eco: 'C65', name: 'Ruy Lopez Berlin Defense', moves: ['e4', 'e5', 'Nf3', 'Nc6', 'Bb5', 'Nf6'] },
  { eco: 'C50', name: 'Italian Game', moves: ['e4', 'e5', 'Nf3', 'Nc6', 'Bc4'] },
  { eco: 'C41', name: 'Philidor Defense', moves: ['e4', 'e5', 'Nf3', 'd6'] },
  { eco: 'C00', name: 'French Defense', moves: ['e4', 'e6'] },
  { eco: 'B12', name: 'Caro-Kann Defense', moves: ['e4', 'c6'] },
  { eco: 'B01', name: 'Scandinavian Defense', moves: ['e4', 'd5'] },
  { eco: 'D02', name: 'London System', moves: ['d4', 'd5', 'Nf3', 'Nf6', 'Bf4'] },
  { eco: 'D06', name: 'Queens Gambit', moves: ['d4', 'd5', 'c4'] },
  { eco: 'D10', name: 'Slav Defense', moves: ['d4', 'd5', 'c4', 'c6'] },
  { eco: 'E60', name: 'Kings Indian Defense', moves: ['d4', 'Nf6', 'c4', 'g6'] },
  { eco: 'A45', name: 'Indian Game', moves: ['d4', 'Nf6'] },
  { eco: 'A04', name: 'Reti Opening', moves: ['Nf3'] },
];

interface TimeClassSpec {
  timeClass: TimeClass;
  timeControl: string;
  base: number;
  increment: number;
  weight: number;
  /** How much the player's judgement degrades as the clock runs down. */
  panic: number;
}

const TIME_CLASS_SPECS: TimeClassSpec[] = [
  { timeClass: 'bullet', timeControl: '60+0', base: 60, increment: 0, weight: 3, panic: 2.6 },
  { timeClass: 'blitz', timeControl: '180+2', base: 180, increment: 2, weight: 5, panic: 1.8 },
  { timeClass: 'rapid', timeControl: '600+5', base: 600, increment: 5, weight: 2, panic: 1.15 },
  { timeClass: 'daily', timeControl: '1/86400', base: 86400, increment: 0, weight: 1, panic: 1 },
];

const OPPONENTS = [
  't_bergstrom', 'nkwame_o', 'rivera_84', 'saoirse_m', 'delacroix', 'k_yamamoto',
  'bright_rook', 'petrosianfan', 'l_okonkwo', 'mira_v', 'hasan_a', 'joon_p',
  'e_tavares', 'zofia_w', 'amaru_q',
];

/** A small deterministic PRNG keeps a given seed reproducible across runs. */
function makeRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pickWeighted<T extends { weight: number }>(items: T[], random: () => number): T {
  const total = items.reduce((sum, item) => sum + item.weight, 0);
  let roll = random() * total;
  for (const item of items) {
    roll -= item.weight;
    if (roll <= 0) return item;
  }
  return items[items.length - 1]!;
}

interface PlayedMove {
  san: string;
  clock: number;
  color: 'w' | 'b';
}

interface SeedGameOptions {
  playerColor: 'w' | 'b';
  spec: TimeClassSpec;
  opening: OpeningLine;
  /** Chance the player picks a move the engine did not rank at all. */
  playerLapseRate: number;
  opponentLapseRate: number;
  maxPlies: number;
  random: () => number;
}

async function playGame(pool: EnginePool, options: SeedGameOptions): Promise<{
  moves: PlayedMove[];
  result: string;
  termination: string;
}> {
  const { random, spec, playerColor } = options;
  const chess = new Chess();
  const moves: PlayedMove[] = [];
  const clocks: Record<'w' | 'b', number> = { w: spec.base, b: spec.base };

  for (const san of options.opening.moves) {
    try {
      chess.move(san);
    } catch {
      break;
    }
    const color = chess.turn() === 'w' ? 'b' : 'w';
    const spent = bookTime(spec, random);
    clocks[color] = Math.max(1, clocks[color] - spent + spec.increment);
    moves.push({ san, clock: clocks[color], color });
  }

  while (!chess.isGameOver() && moves.length < options.maxPlies) {
    const turn = chess.turn();
    const isPlayer = turn === playerColor;
    const clockLeft = clocks[turn];

    // Time pressure makes lapses more likely — the correlation the app later finds.
    const pressure = clockLeft < spec.base * 0.12 ? spec.panic : clockLeft < spec.base * 0.35 ? 1.3 : 1;
    const lapseRate = (isPlayer ? options.playerLapseRate : options.opponentLapseRate) * pressure;

    const candidates = await pool.search(chess.fen(), 8, 4);
    const chosen = chooseMove(chess, candidates.map((c) => c.pv[0]).filter(Boolean) as string[], lapseRate, random);
    if (!chosen) break;

    const move = applyUci(chess, chosen);
    if (!move) break;

    const spent = thinkTime(spec, clockLeft, random);
    clocks[turn] = Math.round((clockLeft - spent + spec.increment) * 10) / 10;
    if (clocks[turn] <= 0) {
      clocks[turn] = 0;
      moves.push({ san: move.san, clock: 0, color: turn });
      return {
        moves,
        result: turn === 'w' ? '0-1' : '1-0',
        termination: `${turn === 'w' ? 'Black' : 'White'} won on time`,
      };
    }
    moves.push({ san: move.san, clock: clocks[turn], color: turn });
  }

  if (!chess.isGameOver()) {
    // The ply cap is an artefact of generation, not a real draw. Adjudicate on the
    // final evaluation so the demo history has a believable spread of results.
    const [line] = await pool.search(chess.fen(), 10, 1);
    const score = line?.score;
    const cp = score?.mate != null ? (score.mate > 0 ? 10000 : -10000) : (score?.cp ?? 0);
    const whiteCp = chess.turn() === 'w' ? cp : -cp;
    if (Math.abs(whiteCp) >= 200) {
      return {
        moves,
        result: whiteCp > 0 ? '1-0' : '0-1',
        termination: `${whiteCp > 0 ? 'Black' : 'White'} resigned`,
      };
    }
    return { moves, result: '1/2-1/2', termination: 'Game drawn by agreement' };
  }

  return { moves, ...outcome(chess) };
}

/**
 * Picks between the engine's top moves, or — with probability `lapseRate` — a move
 * the engine never suggested. That second branch is what produces the hung pieces
 * and allowed forks the pattern detector is supposed to find.
 */
function chooseMove(
  chess: Chess,
  engineMoves: string[],
  lapseRate: number,
  random: () => number,
): string | null {
  const legal = chess.moves({ verbose: true });
  if (legal.length === 0) return null;

  if (random() < lapseRate) {
    const offBook = legal.filter(
      (m) => !engineMoves.includes(`${m.from}${m.to}${m.promotion ?? ''}`),
    );
    const pool = offBook.length > 0 ? offBook : legal;
    const pick = pool[Math.floor(random() * pool.length)]!;
    return `${pick.from}${pick.to}${pick.promotion ?? ''}`;
  }

  if (engineMoves.length === 0) {
    const pick = legal[Math.floor(random() * legal.length)]!;
    return `${pick.from}${pick.to}${pick.promotion ?? ''}`;
  }

  // Favour the top line but not exclusively, so games do not all look identical.
  const weights = [0.62, 0.22, 0.1, 0.06];
  let roll = random();
  for (const [index, move] of engineMoves.entries()) {
    roll -= weights[index] ?? 0.02;
    if (roll <= 0) return move;
  }
  return engineMoves[0]!;
}

function bookTime(spec: TimeClassSpec, random: () => number): number {
  return Math.min(spec.base * 0.02, 0.4 + random() * 1.6);
}

function thinkTime(spec: TimeClassSpec, clockLeft: number, random: () => number): number {
  const typical = Math.max(0.3, (clockLeft / 30) * (0.5 + random()));
  // Every so often a long think, which is where clocks actually get burned.
  const longThink = random() < 0.08 ? typical * (3 + random() * 4) : 0;
  return Math.round(Math.min(clockLeft * 0.9, typical + longThink) * 10) / 10;
}

function outcome(chess: Chess): { result: string; termination: string } {
  if (chess.isCheckmate()) {
    const loser = chess.turn();
    return {
      result: loser === 'w' ? '0-1' : '1-0',
      termination: `${loser === 'w' ? 'Black' : 'White'} won by checkmate`,
    };
  }
  if (chess.isStalemate()) return { result: '1/2-1/2', termination: 'Game drawn by stalemate' };
  if (chess.isInsufficientMaterial()) {
    return { result: '1/2-1/2', termination: 'Game drawn by insufficient material' };
  }
  if (chess.isThreefoldRepetition()) {
    return { result: '1/2-1/2', termination: 'Game drawn by repetition' };
  }
  if (chess.isDraw()) return { result: '1/2-1/2', termination: 'Game drawn by 50-move rule' };
  return { result: '1/2-1/2', termination: 'Game drawn by agreement' };
}

function toPgn(params: {
  white: string;
  black: string;
  result: string;
  termination: string;
  eco: string;
  ecoName: string;
  timeControl: string;
  endTime: number;
  whiteElo: number;
  blackElo: number;
  moves: PlayedMove[];
}): string {
  const date = new Date(params.endTime * 1000);
  const pad = (n: number) => String(n).padStart(2, '0');
  const dateStr = `${date.getUTCFullYear()}.${pad(date.getUTCMonth() + 1)}.${pad(date.getUTCDate())}`;
  const timeStr = `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`;

  const headers = [
    ['Event', 'Live Chess'],
    ['Site', 'Chess.com'],
    ['Date', dateStr],
    ['Round', '-'],
    ['White', params.white],
    ['Black', params.black],
    ['Result', params.result],
    ['ECO', params.eco],
    ['ECOUrl', `https://www.chess.com/openings/${params.ecoName.replace(/\s+/g, '-')}`],
    ['UTCDate', dateStr],
    ['UTCTime', timeStr],
    ['WhiteElo', String(params.whiteElo)],
    ['BlackElo', String(params.blackElo)],
    ['TimeControl', params.timeControl],
    ['Termination', params.termination],
  ]
    .map(([key, value]) => `[${key} "${value}"]`)
    .join('\n');

  const body: string[] = [];
  for (const [index, move] of params.moves.entries()) {
    if (index % 2 === 0) body.push(`${index / 2 + 1}.`);
    body.push(`${move.san} {[%clk ${formatClock(move.clock)}]}`);
  }
  body.push(params.result);

  return `${headers}\n\n${wrap(body.join(' '))}\n`;
}

function formatClock(seconds: number): string {
  const whole = Math.max(0, seconds);
  const h = Math.floor(whole / 3600);
  const m = Math.floor((whole % 3600) / 60);
  const s = (whole % 60).toFixed(1).padStart(4, '0');
  return `${h}:${String(m).padStart(2, '0')}:${s}`;
}

function wrap(text: string, width = 90): string {
  const words = text.split(' ');
  const lines: string[] = [];
  let line = '';
  for (const word of words) {
    if (line.length + word.length + 1 > width) {
      lines.push(line);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  if (line) lines.push(line);
  return lines.join('\n');
}

export interface SeedOptions {
  username: string;
  games: number;
  seed: number;
  depth: number;
  onProgress?: (done: number, total: number, label: string) => void;
}

export async function seedPlayer(pool: EnginePool, options: SeedOptions): Promise<ImportedGame[]> {
  const random = makeRandom(options.seed);
  const games: ImportedGame[] = [];
  const now = Math.floor(Date.now() / 1000);

  for (let i = 0; i < options.games; i += 1) {
    const spec = pickWeighted(TIME_CLASS_SPECS, random);
    const opening = OPENINGS[Math.floor(random() * OPENINGS.length)]!;
    const playerColor: 'w' | 'b' = random() < 0.5 ? 'w' : 'b';
    const opponent = OPPONENTS[Math.floor(random() * OPPONENTS.length)]!;

    // The player slowly improves across the sample so the trend chart has a slope.
    const progress = i / Math.max(1, options.games - 1);
    const playerLapseRate = 0.16 - progress * 0.05;

    const { moves, result, termination } = await playGame(pool, {
      playerColor,
      spec,
      opening,
      playerLapseRate,
      opponentLapseRate: 0.1 + random() * 0.05,
      maxPlies: spec.timeClass === 'bullet' ? 70 : 100,
      random,
    });

    if (moves.length < 10) {
      i -= 1;
      continue;
    }

    // Newest games last in wall-clock terms, spread over roughly four months.
    const endTime = now - Math.round((options.games - i) * (3600 * 18 + random() * 3600 * 20));
    const playerElo = 1180 + Math.round(progress * 90 + random() * 40);
    const opponentElo = playerElo + Math.round((random() - 0.5) * 160);

    const white = playerColor === 'w' ? options.username : opponent;
    const black = playerColor === 'w' ? opponent : options.username;

    const pgn = toPgn({
      white,
      black,
      result,
      termination,
      eco: opening.eco,
      ecoName: opening.name,
      timeControl: spec.timeControl,
      endTime,
      whiteElo: playerColor === 'w' ? playerElo : opponentElo,
      blackElo: playerColor === 'b' ? playerElo : opponentElo,
      moves,
    });

    games.push({
      externalId: `seed:${options.seed}:${i}`,
      source: 'chess.com',
      url: null,
      pgn,
      timeClass: spec.timeClass,
      timeControl: spec.timeControl,
      endTime,
      rated: true,
      whiteUsername: white,
      blackUsername: black,
      whiteRating: playerColor === 'w' ? playerElo : opponentElo,
      blackRating: playerColor === 'b' ? playerElo : opponentElo,
      whiteResult: resultFor(result, 'w', termination),
      blackResult: resultFor(result, 'b', termination),
      eco: opening.eco,
      ecoName: opening.name,
    });

    options.onProgress?.(i + 1, options.games, 'played');
  }

  return games;
}

function resultFor(result: string, color: 'w' | 'b', termination: string): string {
  if (termination.includes('resigned')) {
    const whiteWon = result === '1-0';
    return (color === 'w') === whiteWon ? 'win' : 'resigned';
  }
  if (result === '1/2-1/2') {
    if (termination.includes('stalemate')) return 'stalemate';
    if (termination.includes('repetition')) return 'repetition';
    if (termination.includes('insufficient')) return 'insufficient';
    if (termination.includes('50-move')) return '50move';
    return 'agreed';
  }
  const whiteWon = result === '1-0';
  const won = (color === 'w') === whiteWon;
  if (won) return 'win';
  return termination.includes('on time') ? 'timeout' : 'checkmated';
}

async function main(): Promise<void> {
  const username = process.env.SEED_USERNAME ?? 'm_arroyo';
  const count = Number(process.env.SEED_GAMES ?? 40);
  const seed = Number(process.env.SEED ?? 20260917);
  const depth = Number(process.env.SEED_DEPTH ?? 14);

  const db = getDb();
  const pool = new EnginePool();
  const started = Date.now();

  console.log(`Generating ${count} games for ${username} (engine ${pool.engineName} × ${pool.size})`);
  const games = await seedPlayer(pool, {
    username,
    games: count,
    seed,
    depth,
    onProgress: (done, total) => {
      if (done % 5 === 0 || done === total) console.log(`  played ${done}/${total}`);
    },
  });

  const player = upsertPlayer(db, username);
  let imported = 0;
  for (const game of games) {
    if (insertGame(db, player.id, game, username) !== null) imported += 1;
  }
  db.prepare('UPDATE players SET last_synced_at = ? WHERE id = ?').run(
    Math.floor(Date.now() / 1000),
    player.id,
  );
  console.log(`Stored ${imported} games. Analysing at depth ${depth}…`);

  const job = createJob(db, username);
  await analysePending(db, pool, job.id, player.id, depth);
  db.prepare("UPDATE import_jobs SET status = 'done', stage = 'done' WHERE id = ?").run(job.id);

  console.log(`Done in ${((Date.now() - started) / 1000).toFixed(1)}s`);
  pool.close();
  db.close();
}

if (process.argv[1]?.endsWith('seed.ts') || process.argv[1]?.endsWith('seed.js')) {
  void main();
}
