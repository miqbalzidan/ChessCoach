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
 * `tab=analysis` asks for the board rather than Game Review, and on a desktop browser
 * that is what you get. ON A PHONE IT IS IGNORED, and the reason is worth writing down
 * because it looks like a bug in this app and is not fixable from this app:
 *
 *   Chess.com's mobile app registers chess.com as an Android App Link / iOS Universal
 *   Link. Tapping this URL hands it straight to the installed app — the browser never
 *   runs, so the page that would read `tab` never loads. The app then routes by path
 *   alone, and /analysis/game/<type>/<id> is its Game Review screen. No query string
 *   can change that, because nothing on our side is doing the routing any more.
 *
 * So this link is now labelled for what it actually does — open the game in Chess.com —
 * and `analysisBoardUrl` below is the one that reliably opens a board.
 */
export function chesscomAnalysisUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  const match = /^https?:\/\/(?:www\.)?chess\.com\/game\/(live|daily)\/(\d+)/i.exec(url);
  if (!match) return null;
  return `https://www.chess.com/analysis/game/${match[1]}/${match[2]}?tab=analysis`;
}

/** A FEN we are willing to put in a URL: the four fields that define a position. */
const FEN_SHAPE =
  /^[1-8pnbrqkPNBRQK]+(?:\/[1-8pnbrqkPNBRQK]+){7} [wb] (?:[KQkq]{1,4}|-) (?:[a-h][36]|-)(?: \d+ \d+)?$/;

/**
 * A board you can actually push pieces around on, opened at this exact position.
 *
 * Lichess takes the FEN in the path with underscores for spaces, which is the one
 * position-in-a-URL scheme that is documented and stable. Chess.com has no reliable
 * equivalent — `chess.com/analysis?fen=` is a long-standing forum request rather than
 * a supported feature — and, more to the point, a chess.com URL on a phone is caught
 * by the app before anything can read a parameter. Lichess is not a URL that app
 * claims, so this link goes where it says it goes.
 *
 * Free, no account, engine on the page. The position travels; nothing about the player
 * does.
 */
export function analysisBoardUrl(
  fen: string | null | undefined,
  orientation: 'white' | 'black' = 'white',
): string | null {
  if (!fen) return null;
  const trimmed = fen.trim();
  if (!FEN_SHAPE.test(trimmed)) return null;
  return `https://lichess.org/analysis/standard/${trimmed.replace(/ /g, '_')}?color=${orientation}`;
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
