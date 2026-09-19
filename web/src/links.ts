/**
 * Links out of the app: back to the game on Chess.com, and on to something that
 * teaches the motif you keep losing to.
 *
 * NOTE ON THE LESSON LINKS — these point at Chess.com's glossary pages, which are
 * stable, free and don't need an account. They could not be checked from the machine
 * this was written on (chess.com is unreachable from it), so they are reasoned from
 * Chess.com's documented URL scheme rather than confirmed one by one. They all live
 * in the one table below, so a wrong one is a one-line fix rather than a hunt.
 */

/**
 * Turns a Chess.com game URL into its analysis URL.
 *
 * A game lives at /game/live/123 or /game/daily/123, and the board for it at
 * /analysis/game/live/123. Anything that is not one of those shapes — another site,
 * a PGN someone pasted — gets no link rather than a guessed one.
 *
 * `tab=analysis`, deliberately. The other tab is Game Review, which is Chess.com's
 * own coached walkthrough: it starts an animation, it costs a membership to finish,
 * and it is a second opinion nobody asked for. The point of following this link is
 * to put the position on a board and push the pieces around — this sheet has
 * already said what went wrong.
 */
export function chesscomAnalysisUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  const match = /^https?:\/\/(?:www\.)?chess\.com\/game\/(live|daily)\/(\d+)/i.exec(url);
  if (!match) return null;
  return `https://www.chess.com/analysis/game/${match[1]}/${match[2]}?tab=analysis`;
}

export interface Lesson {
  /** What the link says. */
  title: string;
  url: string;
}

const GLOSSARY = 'https://www.chess.com/terms';

/** One place to study for each motif the analysis can name. */
export const LESSONS: Record<string, Lesson> = {
  'hung-piece': { title: 'Hanging pieces', url: `${GLOSSARY}/hanging-piece-chess` },
  'allowed-fork': { title: 'Forks', url: `${GLOSSARY}/fork-chess` },
  'missed-fork': { title: 'Forks', url: `${GLOSSARY}/fork-chess` },
  'back-rank': { title: 'Back-rank mate', url: `${GLOSSARY}/back-rank-mate` },
  'allowed-mate': { title: 'Checkmate patterns', url: `${GLOSSARY}/checkmate-chess` },
  'missed-mate': { title: 'Checkmate patterns', url: `${GLOSSARY}/checkmate-chess` },
  'losing-exchange': { title: 'The exchange', url: `${GLOSSARY}/exchange-chess` },
  'bad-trade': { title: 'Piece values and trades', url: `${GLOSSARY}/chess-piece-value` },
  'trade-into-worse-endgame': { title: 'Endgame basics', url: `${GLOSSARY}/endgame-chess` },
  'allowed-pin': { title: 'Pins and skewers', url: `${GLOSSARY}/pin-chess` },
  'missed-capture': { title: 'Hanging pieces', url: `${GLOSSARY}/hanging-piece-chess` },
  'king-safety': { title: 'King safety', url: `${GLOSSARY}/king-safety-chess` },
  'loose-pawn-push': { title: 'Pawn structure', url: `${GLOSSARY}/pawn-structure-chess` },
  'missed-check-tactic': { title: 'Forcing moves', url: `${GLOSSARY}/forcing-moves-chess` },
  'retreat-under-pressure': { title: 'Defense', url: `${GLOSSARY}/defense-chess` },
};

export function lessonFor(motif: string | null | undefined): Lesson | null {
  if (!motif) return null;
  return LESSONS[motif] ?? null;
}

/** The motifs recorded against a move, as stored: comma separated, possibly empty. */
export function motifsOf(raw: string | null | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
}
