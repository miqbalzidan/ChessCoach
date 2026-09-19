import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { api, ApiError } from '../api';
import { inSnapshotMode } from '../snapshot';
import { Board } from '../components/Board';
import { ErrorNote, Loading } from '../components/Chrome';
import {
  formatClock,
  formatDate,
  formatEval,
  glyphClass,
  soundForSan,
  timeControlLabel,
} from '../format';
import { playMoveSound, setSoundEnabled, soundEnabled } from '../sound';
import { analysisBoardUrl, chesscomAnalysisUrl, lessonFor, motifsOf } from '../links';
import { GLYPH, VERDICT, type Classification, type Game, type Move } from '../types';
import { Verdict } from '../components/Verdict';

type Filter = 'all' | '??' | '?' | '?!';

const FILTER_CLASSES: Record<Exclude<Filter, 'all'>, Classification> = {
  '??': 'blunder',
  '?': 'mistake',
  '?!': 'inaccuracy',
};

export function Review() {
  const { id } = useParams<{ id: string }>();
  const [game, setGame] = useState<Game | null>(null);
  const [moves, setMoves] = useState<Move[]>([]);
  const [ply, setPly] = useState(0);
  const [filter, setFilter] = useState<Filter>('all');
  const [error, setError] = useState<string | null>(null);
  const [analysing, setAnalysing] = useState(false);
  const [sound, setSound] = useState(soundEnabled);
  const lastPly = useRef<number | null>(null);

  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    api
      .game(Number(id))
      .then((response) => {
        if (cancelled) return;
        setGame(response.game);
        setMoves(response.moves);
        // Open on the player's first serious mistake — you come here to find
        // what went wrong, not to relive the game from move one.
        const firstBlunder = response.moves.find(
          (move) => move.is_player === 1 && move.classification === 'blunder',
        );
        setPly(firstBlunder?.ply ?? 0);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof ApiError ? err.message : 'Could not load that game');
      });
    return () => {
      cancelled = true;
    };
  }, [id]);

  const current = ply > 0 ? moves[ply - 1] : null;
  const playerColor = game?.player_color ?? 'white';

  // Only on a real step. Landing on the first blunder when the game opens should be
  // silent — a sound nobody asked for is the fastest way to get sound turned off.
  useEffect(() => {
    const previous = lastPly.current;
    lastPly.current = ply;
    if (previous === null || previous === ply) return;
    const landed = ply > 0 ? moves[ply - 1] : null;
    playMoveSound(landed ? soundForSan(landed.san) : 'move');
  }, [ply, moves]);

  const counts = useMemo(() => {
    const own = moves.filter((move) => move.is_player === 1);
    return {
      // "all" lists the whole game; the glyph filters only ever show your own moves.
      all: moves.length,
      '??': own.filter((m) => m.classification === 'blunder').length,
      '?': own.filter((m) => m.classification === 'mistake').length,
      '?!': own.filter((m) => m.classification === 'inaccuracy').length,
    };
  }, [moves]);

  const visible = useMemo(() => {
    if (filter === 'all') return moves;
    return moves.filter(
      (move) => move.is_player === 1 && move.classification === FILTER_CLASSES[filter],
    );
  }, [moves, filter]);

  const step = useCallback(
    (delta: number) => {
      setPly((previous) => Math.max(0, Math.min(moves.length, previous + delta)));
    },
    [moves.length],
  );

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'ArrowLeft') {
        event.preventDefault();
        step(-1);
      } else if (event.key === 'ArrowRight') {
        event.preventDefault();
        step(1);
      } else if (event.key === 'Home') {
        setPly(0);
      } else if (event.key === 'End') {
        setPly(moves.length);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [step, moves.length]);

  if (error) return <ErrorNote error={error} />;
  if (!game) return <Loading label="loading game" />;

  const fen = current ? current.fen_after : (moves[0]?.fen_before ?? START_FEN);
  const playerAccuracy =
    playerColor === 'white' ? game.accuracy_white : game.accuracy_black;
  const opponentAccuracy =
    playerColor === 'white' ? game.accuracy_black : game.accuracy_white;

  // Two ways out, because they do different jobs and only one of them is dependable
  // on a phone. `boardUrl` opens the position currently on this board, on a site the
  // Chess.com app does not intercept. `gameUrl` opens the game itself, which on a
  // phone means the Chess.com app's own screen for it — see the note in links.ts.
  const boardUrl = analysisBoardUrl(fen, playerColor);
  const gameUrl = chesscomAnalysisUrl(game.url);

  // The board is drawn from the player's side, so the far strip is the opponent's
  // whenever the player is at the bottom — which is always, by construction.
  const white = {
    name: game.white_username,
    rating: game.white_rating,
    accuracy: game.accuracy_white,
    colour: 'white' as const,
    isPlayer: playerColor === 'white',
  };
  const black = {
    name: game.black_username,
    rating: game.black_rating,
    accuracy: game.accuracy_black,
    colour: 'black' as const,
    isPlayer: playerColor === 'black',
  };
  const topPlayer = playerColor === 'white' ? black : white;
  const bottomPlayer = playerColor === 'white' ? white : black;

  // Eval is always shown from the player's point of view.
  const evalCp = current
    ? current.color === playerColor
      ? current.eval_after
      : -current.eval_after
    : 0;
  const whiteShare = Math.max(4, Math.min(96, evalToShare(evalCp)));

  const runAnalysis = async () => {
    setAnalysing(true);
    try {
      const response = await api.analyseGame(game.id);
      setGame(response.game);
      setMoves(response.moves);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Analysis failed');
    } finally {
      setAnalysing(false);
    }
  };

  if (!game.analysed_at) {
    return (
      <div className="empty">
        <h2>This game has not been analysed yet.</h2>
        <div className="prose" style={{ marginBottom: 20 }}>
          {game.white_username} vs {game.black_username} —{' '}
          {timeControlLabel(game.time_control)} {game.time_class}, {formatDate(game.end_time)}.
        </div>
        {inSnapshotMode() ? (
          /* Analysis needs the engine, which lives on the computer that made this file. */
          <div className="prose">
            A snapshot carries results, not the engine. Analyse this game on the computer
            and export again.
          </div>
        ) : (
          <button type="button" className="btn" onClick={runAnalysis} disabled={analysing}>
            {analysing ? 'analysing…' : 'analyse this game'}
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="review">
      <div className="review-head">
        <div>
          <div className="meta">
            {game.time_class} {timeControlLabel(game.time_control)} · {formatDate(game.end_time)} ·{' '}
            <span className={`result-${game.result}`}>{game.result}</span>
            {game.eco ? ` · ${game.eco_name ?? ''} (${game.eco})` : ''}
          </div>
          <div style={{ font: '600 30px/1.1 var(--display)', marginTop: 7 }}>
            {game.white_username} <span style={{ color: 'var(--muted)' }}>vs</span>{' '}
            {game.black_username}
          </div>
        </div>
        <div className="review-scores">
          <div className="review-actions">
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => {
                const next = !sound;
                setSound(next);
                setSoundEnabled(next);
              }}
              aria-pressed={sound}
              title={sound ? 'Mute move sounds' : 'Unmute move sounds'}
            >
              {sound ? 'sound on' : 'sound off'}
            </button>
            {boardUrl && (
              <a
                className="btn btn-ghost btn-sm"
                href={boardUrl}
                target="_blank"
                rel="noreferrer noopener"
                title="Open this position on a free analysis board"
              >
                analyse ↗
              </a>
            )}
            {gameUrl && (
              <a
                className="btn btn-ghost btn-sm"
                href={gameUrl}
                target="_blank"
                rel="noreferrer noopener"
                title="Open the game on Chess.com"
              >
                chess.com ↗
              </a>
            )}
          </div>
          <div>
            <div className="label-sm">you</div>
            <div className="numeric" style={{ font: '600 34px/1 var(--display)' }}>
              {playerAccuracy?.toFixed(1) ?? '—'}
            </div>
          </div>
          <div>
            <div className="label-sm">them</div>
            <div
              className="numeric"
              style={{ font: '600 34px/1 var(--display)', color: 'var(--muted)' }}
            >
              {opponentAccuracy?.toFixed(1) ?? '—'}
            </div>
          </div>
        </div>
      </div>

      {/* A square is the one fixed shape here, so the grid is eval strip + fluid
          board + sheet — an asymmetry the content dictates. */}
      <div className="review-grid">
        <div
          className="eval-strip"
          aria-hidden="true"
          style={{ '--eval-share': `${whiteShare}%` } as React.CSSProperties}
        >
          <div className="eval-strip-white" />
          <div className="eval-strip-marker" />
        </div>

        <div style={{ padding: '24px 28px 28px' }}>
          {/* Whoever is playing from the far side sits above the board and the near
              side below, the way you would read it over the table. */}
          <PlayerStrip
            name={topPlayer.name}
            rating={topPlayer.rating}
            accuracy={topPlayer.accuracy}
            isPlayer={topPlayer.isPlayer}
            colour={topPlayer.colour}
          />
          <Board
            fen={fen}
            move={current?.uci ?? null}
            bestMove={current && current.classification !== 'best' ? current.best_move_uci : null}
            flipped={playerColor === 'black'}
            animate
            markable
            caption={
              current
                ? `${current.move_number}${current.color === 'white' ? '.' : '…'} ${current.san} ${GLYPH[current.classification]} ${formatEval(current.eval_after * (current.color === playerColor ? 1 : -1), null)}`
                : 'starting position'
            }
          />
          <PlayerStrip
            name={bottomPlayer.name}
            rating={bottomPlayer.rating}
            accuracy={bottomPlayer.accuracy}
            isPlayer={bottomPlayer.isPlayer}
            colour={bottomPlayer.colour}
          />

          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'baseline',
              marginTop: 14,
              gap: 16,
            }}
            className="meta"
          >
            <span>
              {current ? (
                <>
                  {current.is_player === 1 ? (
                    <Verdict classification={current.classification} className="verdict-inline" />
                  ) : null}{' '}
                  after <b>{current.san}</b>
                  {current.best_move_san && current.classification !== 'best' ? (
                    <> — engine played {current.best_move_san}</>
                  ) : null}
                  {current.clock_after !== null ? ` · ${formatClock(current.clock_after)} left` : ''}
                </>
              ) : (
                'use ← → to step through · right-click to mark, right-drag for an arrow'
              )}
            </span>
            <span
              style={{
                color: current && current.win_percent_loss > 10 ? 'var(--vermilion)' : undefined,
                fontWeight: 600,
              }}
              className="numeric"
            >
              eval {formatEval(evalCp, null)}
            </span>
          </div>

          <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
            <button type="button" className="btn btn-ghost" onClick={() => setPly(0)}>
              ⏮
            </button>
            <button type="button" className="btn btn-ghost" onClick={() => step(-1)}>
              ←
            </button>
            <button type="button" className="btn btn-ghost" onClick={() => step(1)}>
              →
            </button>
            <button type="button" className="btn btn-ghost" onClick={() => setPly(moves.length)}>
              ⏭
            </button>
          </div>
        </div>

        <div className="move-sheet">
          {/* The move list filters by annotation glyph rather than asking you to
              scroll 41 moves. */}
          <div className="move-filters">
            {(['all', '??', '?', '?!'] as Filter[]).map((option) => (
              <button
                key={option}
                type="button"
                className={`move-filter${filter === option ? ' is-active' : ''}`}
                onClick={() => setFilter(option)}
                aria-pressed={filter === option}
              >
                {/* The tab says what it filters to rather than only showing the
                    annotation, and carries the same colour as the verdict it selects
                    — four tabs of punctuation told you nothing about which was worse. */}
                {option === 'all' ? (
                  <span className="filter-name">all</span>
                ) : (
                  <span className={`filter-name ${glyphClass(FILTER_CLASSES[option])}`}>
                    {VERDICT[FILTER_CLASSES[option]]}
                    <span className="filter-glyph" aria-hidden="true">
                      {option}
                    </span>
                  </span>
                )}
                <span className="numeric">{counts[option]}</span>
              </button>
            ))}
          </div>

          <div className="move-list">
            {visible.length === 0 ? (
              <div className="prose" style={{ padding: '20px 16px' }}>
                None of your moves in this game were {labelFor(filter)}.
              </div>
            ) : (
              visible.map((move) => (
                <button
                  key={move.ply}
                  type="button"
                  className={`move-row${move.ply === ply ? ' is-current' : ''}`}
                  onClick={() => setPly(move.ply)}
                >
                  <span className="move-num numeric">
                    {move.color === 'white' ? `${move.move_number}.` : ''}
                  </span>
                  <span className="move-san">
                    {move.san}
                    {move.is_player === 0 && filter === 'all' ? (
                      <span style={{ color: 'var(--muted)' }}> ·</span>
                    ) : null}
                  </span>
                  <span className={`glyph-sm ${glyphClass(move.classification)}`}>
                    {move.is_player === 1 ? GLYPH[move.classification] : ''}
                  </span>
                  <span className={`move-cp numeric ${glyphClass(move.classification)}`}>
                    {move.is_player === 1 && move.cp_loss > 30 ? `−${move.cp_loss}` : ''}
                  </span>
                </button>
              ))
            )}
          </div>

          {current && current.is_player === 1 && current.motifs ? (
            <div className="ink-panel" style={{ padding: '20px 18px 22px' }}>
              <div className="label-sm" style={{ color: 'var(--vermilion)', letterSpacing: '.2em' }}>
                what happened here
              </div>
              <div className="coach-prose" style={{ marginTop: 12, fontSize: 15 }}>
                {describeMove(current)}
              </div>
              {(() => {
                // The first motif is the one the prose above leads with, so it is the
                // one worth sending you to read about.
                const lesson = lessonFor(motifsOf(current.motifs)[0]);
                return lesson ? (
                  <a
                    className="lesson-link"
                    href={lesson.url}
                    target="_blank"
                    rel="noreferrer noopener"
                  >
                    learn: {lesson.title} ↗
                  </a>
                ) : null;
              })()}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

/** Name, rating and accuracy for one side of the board. */
function PlayerStrip({
  name,
  rating,
  accuracy,
  isPlayer,
  colour,
}: {
  name: string;
  rating: number | null;
  accuracy: number | null;
  isPlayer: boolean;
  colour: 'white' | 'black';
}) {
  return (
    <div className={`player-strip${isPlayer ? ' is-you' : ''}`}>
      <span className={`player-disc player-disc-${colour}`} aria-hidden="true" />
      <span className="player-name">{name}</span>
      {rating !== null && <span className="player-rating numeric">{rating}</span>}
      {isPlayer && <span className="player-you">you</span>}
      <span className="player-accuracy numeric">
        {accuracy !== null ? `${accuracy.toFixed(1)}%` : '—'}
      </span>
    </div>
  );
}

const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

function evalToShare(cp: number): number {
  // Same logistic the server uses, so the strip and the numbers agree.
  const clamped = Math.max(-1000, Math.min(1000, cp));
  return 100 - (50 + 50 * (2 / (1 + Math.exp(-0.00368208 * clamped)) - 1));
}

function labelFor(filter: Filter): string {
  if (filter === '??') return 'blunders';
  if (filter === '?') return 'mistakes';
  if (filter === '?!') return 'inaccuracies';
  return 'moves';
}

const MOTIF_PROSE: Record<string, string> = {
  'hung-piece': 'left a piece where it could simply be taken',
  'allowed-fork': 'allowed a fork',
  'missed-fork': 'missed a fork of your own',
  'back-rank': 'left the back rank weak',
  'allowed-mate': 'allowed a forced mate',
  'missed-mate': 'missed a forced mate',
  'losing-exchange': 'lost the exchange',
  'bad-trade': 'traded into a worse position',
  'trade-into-worse-endgame': 'traded into a losing endgame',
  'allowed-pin': 'walked into a pin or skewer',
  'missed-capture': 'missed free material',
  'king-safety': 'exposed your king',
  'loose-pawn-push': 'loosened the pawns in front of your king',
  'missed-check-tactic': 'missed a forcing check',
  'retreat-under-pressure': 'retreated instead of defending',
};

function describeMove(move: Move): string {
  const motifs = move.motifs
    .split(',')
    .filter(Boolean)
    .map((motif) => MOTIF_PROSE[motif] ?? motif);
  const lead = motifs.length > 0 ? `This ${motifs.join(', and ')}.` : '';
  const cost = ` It cost ${move.win_percent_loss.toFixed(0)}% of your winning chances`;
  const better = move.best_move_san ? `; ${move.best_move_san} was the move` : '';
  const clock =
    move.clock_after !== null && move.clock_after < 20
      ? `. You had ${formatClock(move.clock_after)} left`
      : '';
  return `${lead}${cost}${better}${clock}.`;
}
