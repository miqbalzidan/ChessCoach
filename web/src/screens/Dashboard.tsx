import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, ApiError } from '../api';
import { BaselineBars } from '../components/BaselineBars';
import {
  Empty,
  ErrorNote,
  Loading,
  OpeningBand,
  TimeClassBand,
  lensOpeningLabel,
  openingKey,
} from '../components/Chrome';
import { pluralise, relativeTime, scopeLabel, signed } from '../format';
import { lensKey } from '../types';
import type {
  AnalysisSource,
  Coaching,
  Dashboard as DashboardData,
  Lens,
  OpeningRow,
  Pattern,
  Profile,
  Scope,
  Trait,
} from '../types';

export function Dashboard({
  username,
  lens,
  onScopeChange,
  onLensChange,
  engine,
}: {
  username: string | null;
  lens: Lens;
  onScopeChange: (scope: Scope) => void;
  onLensChange: (lens: Lens) => void;
  engine?: string;
}) {
  const navigate = useNavigate();
  const [data, setData] = useState<DashboardData | null>(null);
  const [patterns, setPatterns] = useState<Pattern[]>([]);
  const [coaching, setCoaching] = useState<Coaching | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!username) return;
    let cancelled = false;
    setLoading(true);
    setError(null);

    Promise.all([
      api.dashboard(username, lens),
      api.patterns(username, lens),
      api.profile(username, lens).catch(() => null),
    ])
      .then(([dashboard, patternResponse, profileResponse]) => {
        if (cancelled) return;
        setData(dashboard);
        setPatterns(patternResponse.patterns);
        setProfile(profileResponse?.profile ?? null);
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
    // The lens is an object rebuilt on every render, so the key is the dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [username, lensKey(lens)]);

  // Coaching is a separate request because it can be slow and the numbers should
  // never wait on it.
  useEffect(() => {
    if (!username) return;
    let cancelled = false;
    setCoaching(null);
    api
      .coaching(username, lens)
      .then((response) => {
        if (!cancelled) setCoaching(response.coaching);
      })
      .catch(() => {
        if (!cancelled) setCoaching(null);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [username, lensKey(lens)]);

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
          scope={lens.scope}
          onChange={onScopeChange}
          summaries={data.timeClasses}
          totalGames={data.timeClasses.reduce((sum, t) => sum + t.games, 0)}
        />
        <OpeningBand lens={lens} openings={data.openings} onChange={onLensChange} />
        <Empty title="Nothing analysed in this segment yet.">
          {lens.eco
            ? 'No analysed games in that opening. Clear the opening filter, or pick another one.'
            : headline.games > 0
              ? `${pluralise(headline.games, 'game')} imported but not analysed. Start the analysis from Settings, or pick another time class.`
              : 'No games in this time class. Try another segment, or import more games.'}
        </Empty>
      </>
    );
  }

  const openingNote = lensOpeningLabel(lens, data.openings);
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
          {/* One leak is a way, not "1 ways"; one game is a game, not "1 games". Both
              singulars turn up for real — an opening filter often lands on a single
              pattern, and a phone's first import is often a single game. */}
          {patterns.length > 0
            ? patterns.length === 1
              ? 'way.'
              : 'ways.'
            : headline.analysedGames === 1
              ? 'game.'
              : 'games.'}
        </h1>
        <div className="headline-aside">
          {pluralise(headline.analysedGames, 'game')} analysed
          <br />
          {headline.record.win}W · {headline.record.loss}L · {headline.record.draw}D ·{' '}
          {headline.winRate.toFixed(0)}% wins
          <br />
          {describeSources(data.sources) || (engine ? `${engine}` : '')}
          {' · '}synced {relativeTime(data.player.last_synced_at)}
          {openingNote ? (
            <>
              <br />
              <span className="opening-note">{openingNote}</span>
            </>
          ) : null}
        </div>
      </div>

      <TimeClassBand
        scope={lens.scope}
        onChange={onScopeChange}
        summaries={data.timeClasses}
        totalGames={data.timeClasses.reduce((sum, t) => sum + t.games, 0)}
      />
      <OpeningBand lens={lens} openings={data.openings} onChange={onLensChange} />

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

      {data.sources.length > 1 && (
        /* Sat with the trend on purpose: this is the chart someone would otherwise
           read as improvement or decline, when part of the step is the instrument
           changing underneath it. */
        <div className="mixed-analysis">
          <div className="label">two engines in this segment</div>
          <div className="prose">
            {data.sources
              .map((source) => `${pluralise(source.games, 'game')} by ${source.engine} at depth ${source.depth}`)
              .join(', ')}
            . A shallower search finds more to complain about, so part of any step in the
            trend below is the measurement changing rather than your chess. Compare like
            with like before reading much into it.
          </div>
        </div>
      )}

      <div className="chart-block">
        <div className="chart-head">
          <div className="label">
            accuracy, last {trend.length} games — bars below the rule are blunder games
          </div>
          <div className="meta">
            {scopeLabel(lens.scope)}
            {openingNote ? ` · ${openingNote}` : ''}
          </div>
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

      <Openings rows={data.openings} lens={lens} onPick={onLensChange} />

      <ScoutingReport profile={profile} />
    </>
  );
}

/**
 * The openings themselves, and the way into every other number on this page.
 *
 * These were always computed and never shown. As a table they answer "which of my
 * openings is costing me", and as a row of buttons they answer the follow-up: pick
 * one and the whole sheet — patterns, phases, clock, scouting report — is recomputed
 * inside it.
 */
function Openings({
  rows,
  lens,
  onPick,
}: {
  rows: OpeningRow[];
  lens: Lens;
  onPick: (lens: Lens) => void;
}) {
  if (rows.length === 0) return null;
  const active = lens.eco ? `${lens.eco}:${lens.color ?? ''}` : '';

  return (
    <div className="openings">
      <div className="section-head">
        <div className="label">openings · click one to read the sheet inside it</div>
        <div className="meta">two games minimum</div>
      </div>

      <div className="rows">
        <div className="row-head label opening-row">
          <span>eco</span>
          <span>opening</span>
          <span>as</span>
          <span style={{ textAlign: 'right' }}>games</span>
          <span style={{ textAlign: 'right' }}>w · l · d</span>
          <span style={{ textAlign: 'right' }}>wins</span>
          <span style={{ textAlign: 'right' }}>accuracy</span>
        </div>
        {rows.map((row) => {
          const isActive = openingKey(row) === active;
          return (
            <button
              key={openingKey(row)}
              type="button"
              className={`row opening-row${isActive ? ' is-active' : ''}`}
              aria-pressed={isActive}
              onClick={() =>
                onPick(
                  isActive
                    ? { scope: lens.scope }
                    : { scope: lens.scope, eco: row.eco, color: row.color as 'white' | 'black' },
                )
              }
            >
              <span className="meta numeric">{row.eco}</span>
              <span style={{ font: '600 15px/1.2 var(--display)' }}>{row.name}</span>
              <span className="meta">{row.color}</span>
              <span className="numeric" style={{ textAlign: 'right' }}>
                {row.games}
              </span>
              <span className="meta numeric" style={{ textAlign: 'right' }}>
                {row.wins} · {row.losses} · {row.draws}
              </span>
              <span
                className="numeric"
                style={{ textAlign: 'right', font: '600 17px/1 var(--display)' }}
              >
                {row.winRate.toFixed(0)}%
              </span>
              <span className="numeric meta" style={{ textAlign: 'right' }}>
                {row.accuracy === null ? '—' : row.accuracy.toFixed(1)}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

/**
 * The same evidence read the other way round: not "what did I get wrong" but "what
 * would someone do to beat me". Strengths are here because a sheet that only ever
 * lists faults stops being read — and because knowing what holds up is how you know
 * what to trade into.
 */
function ScoutingReport({ profile }: { profile: Profile | null }) {
  if (!profile) return null;

  if (profile.thin) {
    return (
      <div className="scout">
        <div className="section-head">
          <div className="label">scouting report</div>
          <div className="meta">{pluralise(profile.games, 'game')}</div>
        </div>
        <div className="prose scout-thin">
          Not enough games in this segment to say anything worth acting on. A profile
          drawn from a handful of games mostly describes the handful.
        </div>
      </div>
    );
  }

  if (profile.strengths.length === 0 && profile.weaknesses.length === 0) {
    return (
      <div className="scout">
        <div className="section-head">
          <div className="label">scouting report</div>
          <div className="meta">{pluralise(profile.games, 'game')}</div>
        </div>
        <div className="prose scout-thin">
          Nothing stands out either way — you play your field about evenly across
          phases, openings and the clock.
        </div>
      </div>
    );
  }

  return (
    <div className="scout">
      <div className="section-head">
        <div className="label">scouting report · how they beat you</div>
        <div className="meta">drawn from {pluralise(profile.games, 'analysed game')}</div>
      </div>

      <div className="scout-grid">
        <TraitColumn
          heading="what holds up"
          empty="Nothing separates you from your field yet."
          traits={profile.strengths}
          kind="strength"
        />
        <TraitColumn
          heading="what to aim at"
          empty="No clear way in — which is its own kind of good news."
          traits={profile.weaknesses}
          kind="weakness"
        />
      </div>
    </div>
  );
}

function TraitColumn({
  heading,
  empty,
  traits,
  kind,
}: {
  heading: string;
  empty: string;
  traits: Trait[];
  kind: 'strength' | 'weakness';
}) {
  return (
    <div>
      <div className={`scout-heading scout-heading-${kind}`}>{heading}</div>
      {traits.length === 0 ? (
        <div className="prose scout-thin">{empty}</div>
      ) : (
        traits.map((trait) => (
          <div key={trait.key} className={`trait trait-${kind}`}>
            <div className="trait-title">{trait.title}</div>
            <div className="prose trait-detail">{trait.detail}</div>
            {/* The number that produced the claim, never far from it. */}
            <div className="trait-evidence numeric">{trait.evidence}</div>
          </div>
        ))
      )}
    </div>
  );
}

/**
 * The provenance line: one instrument named, or a count when there are several.
 *
 * The exact split is spelled out beside the trend, where it actually matters; up here
 * it only needs to stop the masthead claiming a single engine measured everything.
 */
function describeSources(sources: AnalysisSource[]): string {
  if (sources.length === 0) return '';
  if (sources.length === 1) {
    const only = sources[0]!;
    return `${only.engine} · depth ${only.depth}`;
  }
  return `${sources.length} engines · depth ${Math.min(...sources.map((s) => s.depth))}–${Math.max(
    ...sources.map((s) => s.depth),
  )}`;
}

function severityOf(pattern: Pattern): string {
  if (pattern.glyph === '??') return 'blunder';
  if (pattern.glyph === '?') return 'mistake';
  return 'inaccuracy';
}
