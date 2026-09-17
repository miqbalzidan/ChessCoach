import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, ApiError } from '../api';
import { BaselineBars } from '../components/BaselineBars';
import { Empty, ErrorNote, Loading, TimeClassBand } from '../components/Chrome';
import { pluralise, relativeTime, scopeLabel, signed } from '../format';
import type { Coaching, Dashboard as DashboardData, Pattern, Scope } from '../types';

export function Dashboard({
  username,
  scope,
  onScopeChange,
  engine,
}: {
  username: string | null;
  scope: Scope;
  onScopeChange: (scope: Scope) => void;
  engine?: string;
}) {
  const navigate = useNavigate();
  const [data, setData] = useState<DashboardData | null>(null);
  const [patterns, setPatterns] = useState<Pattern[]>([]);
  const [coaching, setCoaching] = useState<Coaching | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!username) return;
    let cancelled = false;
    setLoading(true);
    setError(null);

    Promise.all([api.dashboard(username, scope), api.patterns(username, scope)])
      .then(([dashboard, patternResponse]) => {
        if (cancelled) return;
        setData(dashboard);
        setPatterns(patternResponse.patterns);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof ApiError ? err.message : 'Could not load the sheet');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [username, scope]);

  // Coaching is a separate request because it can be slow and the numbers should
  // never wait on it.
  useEffect(() => {
    if (!username) return;
    let cancelled = false;
    setCoaching(null);
    api
      .coaching(username, scope)
      .then((response) => {
        if (!cancelled) setCoaching(response.coaching);
      })
      .catch(() => {
        if (!cancelled) setCoaching(null);
      });
    return () => {
      cancelled = true;
    };
  }, [username, scope]);

  if (!username) {
    return (
      <Empty title="No games yet.">
        Import a Chess.com username, or paste a PGN, and every move gets run through
        Stockfish. The sheet fills in once the first games are analysed.
      </Empty>
    );
  }

  if (loading && !data) return <Loading label="reading the sheet" />;
  if (error) return <ErrorNote error={error} />;
  if (!data) return null;

  const { headline, phases, clock, trend } = data;

  if (headline.analysedGames === 0) {
    return (
      <>
        <TimeClassBand
          scope={scope}
          onChange={onScopeChange}
          summaries={data.timeClasses}
          totalGames={data.timeClasses.reduce((sum, t) => sum + t.games, 0)}
        />
        <Empty title="Nothing analysed in this segment yet.">
          {headline.games > 0
            ? `${pluralise(headline.games, 'game')} imported but not analysed. Start the analysis from Settings, or pick another time class.`
            : 'No games in this time class. Try another segment, or import more games.'}
        </Empty>
      </>
    );
  }

  const worstPhase = [...phases].sort((a, b) => b.share - a.share)[0];
  const scramble = clock.buckets.find((bucket) => bucket.label === '<20s');
  const hasClockData = clock.buckets.some((bucket) => bucket.moves > 0);
  // Time pressure is a finding, not an assumption — say what the buckets show,
  // including when they show the clock is not the problem.
  const pressured = clock.buckets
    .filter((bucket) => bucket.label !== '>60s' && bucket.moves > 0)
    .sort((a, b) => b.multiplier - a.multiplier)[0];
  const clockMatters = pressured !== undefined && pressured.multiplier >= 1.3;

  return (
    <>
      <div className="headline-row">
        <h1 className="headline">
          You keep losing
          <br />
          the same <em>{patterns.length || headline.analysedGames}</em>{' '}
          {patterns.length ? 'ways.' : 'games.'}
        </h1>
        <div className="headline-aside">
          {pluralise(headline.analysedGames, 'game')} analysed
          <br />
          {headline.record.win}W · {headline.record.loss}L · {headline.record.draw}D ·{' '}
          {headline.winRate.toFixed(0)}% wins
          <br />
          {engine ? `${engine} · ` : ''}synced {relativeTime(data.player.last_synced_at)}
        </div>
      </div>

      <TimeClassBand
        scope={scope}
        onChange={onScopeChange}
        summaries={data.timeClasses}
        totalGames={data.timeClasses.reduce((sum, t) => sum + t.games, 0)}
      />

      <div className="stat-row">
        <div className="stat stat-blunders">
          <div className="label">blunders per game</div>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginTop: 6 }}>
            <div className="stat-hero numeric">{headline.blundersPerGame.toFixed(2)}</div>
            <div className="stat-note">
              {headline.blundersPerGameDelta === null ? (
                'no earlier window'
              ) : (
                <span
                  className={headline.blundersPerGameDelta > 0 ? 'delta-worse' : 'delta-better'}
                >
                  {signed(headline.blundersPerGameDelta, 2)}
                </span>
              )}
              <br />
              vs 30d earlier
            </div>
          </div>
        </div>

        <div className="stat stat-accuracy">
          <div className="label">accuracy</div>
          <div className="stat-major numeric" style={{ marginTop: 8 }}>
            {headline.accuracy.toFixed(1)}
            <span className="stat-unit">%</span>
          </div>
          <div className="stat-note">
            median move loss
            <br />
            {headline.medianCentipawnLoss} centipawns
          </div>
        </div>

        <div className="stat stat-phase">
          <div className="label">where it goes wrong</div>
          <div className="phase-bar">
            {phases.map((phase) => (
              <span
                key={phase.phase}
                style={{
                  width: `${phase.share}%`,
                  background:
                    phase.phase === worstPhase?.phase
                      ? 'var(--vermilion)'
                      : phase.phase === 'opening'
                        ? 'rgba(20,19,15,.16)'
                        : 'rgba(20,19,15,.5)',
                }}
                title={`${phase.phase}: ${phase.share}% of mistakes, ${phase.rate} per 100 moves`}
              />
            ))}
          </div>
          <div className="phase-legend">
            {phases.map((phase) => (
              <span
                key={phase.phase}
                style={
                  phase.phase === worstPhase?.phase
                    ? { color: 'var(--vermilion)', fontWeight: 600 }
                    : undefined
                }
              >
                {phase.phase} {phase.share}%
              </span>
            ))}
          </div>
        </div>
      </div>

      <div className="chart-block">
        <div className="chart-head">
          <div className="label">
            accuracy, last {trend.length} games — bars below the rule are blunder games
          </div>
          <div className="meta">{scopeLabel(scope)}</div>
        </div>
        <BaselineBars trend={trend} onSelect={(point) => navigate(`/review/${point.gameId}`)} />
      </div>

      <div className="split">
        <div>
          <div className="label" style={{ marginBottom: 16 }}>
            recurring patterns · ranked by rating cost
          </div>

          {patterns.length === 0 ? (
            <div className="prose">
              No pattern repeats often enough to be worth naming yet. Analyse more games —
              a leak needs at least three occurrences before it means anything.
            </div>
          ) : (
            <div className="pattern-list">
              {patterns.slice(0, 4).map((pattern) => {
                const note = coaching?.patterns.find((entry) => entry.key === pattern.key);
                return (
                  <button
                    type="button"
                    key={pattern.key}
                    className="pattern-row"
                    onClick={() => navigate(`/patterns?focus=${pattern.key}`)}
                  >
                    <div className={`glyph glyph-${severityOf(pattern)}`}>{pattern.glyph}</div>
                    <div>
                      <div className="pattern-title">{pattern.title}</div>
                      <div className="prose" style={{ marginTop: 6, maxWidth: '56ch' }}>
                        {note?.explanation ?? pattern.mechanism}
                      </div>
                      <div className="pattern-meta">
                        {pattern.timeClasses.join(' · ')} — {pattern.occurrences} occurrences
                        {pattern.phaseShare >= 50 ? `, mostly in the ${pattern.phase}` : ''}
                      </div>
                    </div>
                    <div className="pattern-cost numeric">
                      −{pattern.eloCost} elo
                      <br />
                      <span className="study">study →</span>
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </div>

        <aside className="ink-panel">
          <div className="label">clock pressure</div>
          {hasClockData ? (
            <>
              <div className="coach-prose" style={{ marginTop: 14 }}>
                {clockMatters ? (
                  <>
                    With <em style={{ color: 'var(--vermilion-pale)' }}>{pressured.label}</em> on the
                    clock, your blunder rate multiplies by{' '}
                    <span
                      style={{ font: '600 30px/1 var(--display)', color: '#fff', verticalAlign: '-4px' }}
                      className="numeric"
                    >
                      {pressured.multiplier.toFixed(1)}
                    </span>
                  </>
                ) : (
                  <>
                    Your blunder rate barely moves with the clock
                    {scramble && scramble.moves > 0 ? (
                      <>
                        {' '}
                        — <em style={{ color: 'var(--vermilion-pale)' }}>{scramble.multiplier.toFixed(1)}×</em>{' '}
                        under 20 seconds
                      </>
                    ) : null}
                    . These are not time-pressure mistakes.
                  </>
                )}
              </div>
              <div style={{ marginTop: 20, display: 'flex', flexDirection: 'column', gap: 9 }}>
                {clock.buckets.map((bucket) => {
                  const worst = clockMatters && bucket.label === pressured.label;
                  const widest = Math.max(...clock.buckets.map((b) => b.rate), 0.01);
                  return (
                    <div key={bucket.label} className={`bar-row${worst ? ' is-worst' : ''}`}>
                      <span>{bucket.label}</span>
                      <div className="bar-track">
                        <div
                          className="bar-fill"
                          style={{ width: `${Math.min(100, (bucket.rate / widest) * 100)}%` }}
                        />
                      </div>
                      <span className="numeric">{bucket.multiplier.toFixed(1)}</span>
                    </div>
                  );
                })}
              </div>
            </>
          ) : (
            <div className="coach-prose" style={{ marginTop: 14 }}>
              No clock data in this segment — Chess.com only records it for live games.
            </div>
          )}

          {coaching && (
            <div
              className="prose"
              style={{
                marginTop: 20,
                borderTop: '1px solid rgba(232,226,212,.2)',
                paddingTop: 16,
              }}
            >
              {coaching.diagnosis}
            </div>
          )}
        </aside>
      </div>
    </>
  );
}

function severityOf(pattern: Pattern): string {
  if (pattern.glyph === '??') return 'blunder';
  if (pattern.glyph === '?') return 'mistake';
  return 'inaccuracy';
}
