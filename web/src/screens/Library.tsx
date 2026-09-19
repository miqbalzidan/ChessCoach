import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, ApiError } from '../api';
import { Empty, ErrorNote, Loading, OpeningBand } from '../components/Chrome';
import { formatDate, pluralise, timeControlLabel } from '../format';
import { lensKey, TIME_CLASSES } from '../types';
import type { Game, GameResult, Lens, OpeningRow, Scope } from '../types';

export function Library({
  username,
  lens,
  onScopeChange,
  onLensChange,
}: {
  username: string | null;
  lens: Lens;
  onScopeChange: (scope: Scope) => void;
  onLensChange: (lens: Lens) => void;
}) {
  const navigate = useNavigate();
  const [games, setGames] = useState<Game[]>([]);
  const [openings, setOpenings] = useState<OpeningRow[]>([]);
  const [total, setTotal] = useState(0);
  const [result, setResult] = useState<GameResult | 'all'>('all');
  const [opponent, setOpponent] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!username) return;
    let cancelled = false;
    setLoading(true);

    // Debounced so typing an opponent name does not fire a request per keystroke.
    const timer = setTimeout(() => {
      api
        .games(username, {
          timeClass: lens.scope,
          eco: lens.eco ?? undefined,
          color: lens.color ?? undefined,
          result,
          opponent: opponent.trim(),
          limit: 100,
        })
        .then((response) => {
          if (cancelled) return;
          setGames(response.games);
          setTotal(response.total);
          setError(null);
        })
        .catch((err: unknown) => {
          if (!cancelled) setError(err instanceof ApiError ? err.message : 'Could not load games');
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
    }, opponent ? 220 : 0);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // The lens is an object rebuilt on every render, so the key is the dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [username, lensKey(lens), result, opponent]);

  // The opening menu belongs to the time class, not to the filtered list, so it is
  // fetched on its own and survives a filter that matches nothing.
  useEffect(() => {
    if (!username) return;
    let cancelled = false;
    api
      .openings(username, lens.scope)
      .then((response) => {
        if (!cancelled) setOpenings(response.openings);
      })
      .catch(() => {
        if (!cancelled) setOpenings([]);
      });
    return () => {
      cancelled = true;
    };
  }, [username, lens.scope]);

  if (!username) {
    return <Empty title="Nothing imported yet.">Import a username first, then every game lands here.</Empty>;
  }

  return (
    <>
      <div className="headline-row">
        <h1 className="headline" style={{ fontSize: 'clamp(30px, 4vw, 54px)' }}>
          {pluralise(total, 'game')}.
        </h1>
        <div className="headline-aside">
          Click any row to open the review.
          <br />
          Rows without an accuracy figure have not been analysed yet.
        </div>
      </div>

      <div className="band" role="group" aria-label="Filter by time class">
        <div className="band-label">time class</div>
        <button
          type="button"
          className={`band-option${lens.scope === 'all' ? ' is-active' : ''}`}
          onClick={() => onScopeChange('all')}
        >
          All
        </button>
        {TIME_CLASSES.map((timeClass) => (
          <button
            key={timeClass}
            type="button"
            className={`band-option${lens.scope === timeClass ? ' is-active' : ''}`}
            onClick={() => onScopeChange(timeClass)}
          >
            {timeClass}
          </button>
        ))}
      </div>

      <OpeningBand lens={lens} openings={openings} onChange={onLensChange} />

      <div
        style={{
          margin: '0 var(--margin)',
          padding: '18px 0',
          display: 'flex',
          gap: 14,
          flexWrap: 'wrap',
          alignItems: 'flex-end',
          borderBottom: '1px solid var(--rule)',
        }}
      >
        <label className="field" style={{ flex: '1 1 240px' }}>
          <span className="field-label">search opponent</span>
          <input
            className="input"
            value={opponent}
            placeholder="username"
            onChange={(event) => setOpponent(event.target.value)}
          />
        </label>
        <label className="field" style={{ flex: '0 0 170px' }}>
          <span className="field-label">result</span>
          <select
            className="select"
            value={result}
            onChange={(event) => setResult(event.target.value as GameResult | 'all')}
          >
            <option value="all">all results</option>
            <option value="win">wins</option>
            <option value="loss">losses</option>
            <option value="draw">draws</option>
          </select>
        </label>
      </div>

      {error ? (
        <ErrorNote error={error} />
      ) : loading && games.length === 0 ? (
        <Loading label="loading games" />
      ) : games.length === 0 ? (
        <Empty title="No games match that filter.">
          Try a different time class, opening or result.
        </Empty>
      ) : (
        <div className="rows">
          <div className="row-head label game-row">
            <span>date</span>
            <span>opponent</span>
            <span>opening</span>
            <span>result</span>
            <span className="game-accuracy">accuracy</span>
            <span className="game-analysis">analysis</span>
          </div>
          {games.map((game) => {
            const accuracy =
              game.player_color === 'white' ? game.accuracy_white : game.accuracy_black;
            return (
              <button
                key={game.id}
                type="button"
                className="row game-row"
                onClick={() => navigate(`/review/${game.id}`)}
              >
                <span className="meta numeric game-date">{formatDate(game.end_time)}</span>
                <span className="game-opponent">
                  <span style={{ font: '600 15px/1.2 var(--display)' }}>{game.opponent}</span>
                  <span className="meta">
                    {' '}
                    {game.opponent_rating ?? ''} · as {game.player_color}
                  </span>
                </span>
                <span className="meta game-opening">
                  {game.eco ? `${game.eco}` : '—'}
                  <br />
                  {game.time_class} {timeControlLabel(game.time_control)}
                </span>
                <span className={`game-result result-${game.result}`}>{game.result}</span>
                <span className="numeric game-accuracy">
                  {accuracy === null ? <span className="meta">—</span> : accuracy.toFixed(1)}
                </span>
                <span className="meta numeric game-analysis">
                  {game.analysed_at ? `depth ${game.analysis_depth ?? '—'}` : 'pending'}
                </span>
              </button>
            );
          })}
        </div>
      )}
    </>
  );
}
