import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { api, ApiError } from '../api';
import { Board } from '../components/Board';
import { lessonFor } from '../links';
import {
  Empty,
  ErrorNote,
  Loading,
  OpeningBand,
  TimeClassBand,
  lensOpeningLabel,
} from '../components/Chrome';
import { formatClock, formatDate, pluralise } from '../format';
import { lensKey } from '../types';
import type { Coaching, Lens, OpeningRow, Pattern, Scope, TimeClassSummary } from '../types';

export function Patterns({
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
  const [params, setParams] = useSearchParams();
  const focus = params.get('focus');

  const [patterns, setPatterns] = useState<Pattern[]>([]);
  const [summaries, setSummaries] = useState<TimeClassSummary[]>([]);
  const [openings, setOpenings] = useState<OpeningRow[]>([]);
  const [coaching, setCoaching] = useState<Coaching | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!username) return;
    let cancelled = false;
    setLoading(true);

    Promise.all([api.patterns(username, lens), api.dashboard(username, lens)])
      .then(([patternResponse, dashboard]) => {
        if (cancelled) return;
        setPatterns(patternResponse.patterns);
        setSummaries(dashboard.timeClasses);
        setOpenings(dashboard.openings);
        setError(null);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof ApiError ? err.message : 'Could not load patterns');
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

  useEffect(() => {
    if (!username) return;
    let cancelled = false;
    setCoaching(null);
    api
      .coaching(username, lens)
      .then((response) => {
        if (!cancelled) setCoaching(response.coaching);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [username, lensKey(lens)]);

  const regenerate = async () => {
    if (!username) return;
    setRefreshing(true);
    try {
      const response = await api.coaching(username, lens, true);
      setCoaching(response.coaching);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not regenerate the summary');
    } finally {
      setRefreshing(false);
    }
  };

  if (!username) {
    return <Empty title="No patterns yet.">Import and analyse some games first.</Empty>;
  }
  if (loading && patterns.length === 0) return <Loading label="clustering mistakes" />;
  if (error) return <ErrorNote error={error} />;

  const openingNote = lensOpeningLabel(lens, openings);

  return (
    <>
      <div className="headline-row">
        <h1 className="headline" style={{ fontSize: 'clamp(30px, 4.4vw, 62px)' }}>
          {patterns.length > 0 ? (
            <>
              <em>{patterns.length}</em> leaks,
              <br />
              ranked by what they cost.
            </>
          ) : (
            'No repeating leaks yet.'
          )}
        </h1>
        <div className="headline-aside">
          A pattern needs three occurrences before it appears here.
          <br />
          Rating cost is the expected score you lost to it, converted at K=10.
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
        summaries={summaries}
        totalGames={summaries.reduce((sum, t) => sum + t.games, 0)}
      />
      <OpeningBand lens={lens} openings={openings} onChange={onLensChange} />

      {coaching && coaching.headline ? (
        <div className="split" style={{ paddingBottom: 0 }}>
          <div>
            <div className="label">the short version</div>
            <div
              className="coach-prose"
              style={{ marginTop: 12, fontSize: 20, lineHeight: 1.45, maxWidth: '46ch' }}
            >
              {coaching.diagnosis}
            </div>
            <div className="meta" style={{ marginTop: 14 }}>
              written by {coaching.model === 'offline' ? 'the offline summariser' : coaching.model}
              {' · '}
              <button
                type="button"
                onClick={regenerate}
                disabled={refreshing}
                style={{
                  background: 'none',
                  border: 0,
                  padding: 0,
                  color: 'var(--vermilion)',
                  font: 'inherit',
                  textDecoration: 'underline',
                }}
              >
                {refreshing ? 'regenerating…' : 'regenerate'}
              </button>
            </div>
          </div>

          {coaching.studyPlan.length > 0 && (
            <aside className="ink-panel">
              <div className="label">what to do next</div>
              <ol style={{ margin: '14px 0 0', paddingLeft: 18 }}>
                {coaching.studyPlan.map((step, index) => (
                  <li key={index} className="coach-prose" style={{ marginBottom: 12 }}>
                    {step}
                  </li>
                ))}
              </ol>
            </aside>
          )}
        </div>
      ) : null}

      {patterns.length === 0 ? (
        <Empty title="Nothing repeats often enough yet.">
          Analyse more games in this segment — single mistakes are noise, and this screen
          only shows what keeps happening.
        </Empty>
      ) : (
        <div style={{ margin: '24px var(--margin) 48px' }}>
          {patterns.map((pattern) => (
            <PatternCard
              key={pattern.key}
              pattern={pattern}
              note={coaching?.patterns.find((entry) => entry.key === pattern.key)}
              open={focus === pattern.key}
              onToggle={() => {
                const next = new URLSearchParams(params);
                if (focus === pattern.key) next.delete('focus');
                else next.set('focus', pattern.key);
                setParams(next, { replace: true });
              }}
              onOpenGame={(gameId) => navigate(`/review/${gameId}`)}
            />
          ))}
        </div>
      )}
    </>
  );
}

function PatternCard({
  pattern,
  note,
  open,
  onToggle,
  onOpenGame,
}: {
  pattern: Pattern;
  note?: { explanation: string; drill: string };
  open: boolean;
  onToggle: () => void;
  onOpenGame: (gameId: number) => void;
}) {
  const severity =
    pattern.glyph === '??' ? 'blunder' : pattern.glyph === '?' ? 'mistake' : 'inaccuracy';

  return (
    <div>
      <button
        type="button"
        className={`pattern-row${open ? ' is-open' : ''}`}
        onClick={onToggle}
        aria-expanded={open}
      >
        <div className={`glyph glyph-${severity}`}>{pattern.glyph}</div>
        <div>
          <div className="pattern-title">{pattern.title}</div>
          <div className="prose" style={{ marginTop: 6, maxWidth: '58ch' }}>
            {note?.explanation ?? pattern.mechanism}
          </div>
          <div className="pattern-meta">
            {pluralise(pattern.occurrences, 'occurrence')} across{' '}
            {pluralise(pattern.gamesAffected, 'game')} · {pattern.timeClasses.join(' · ')} ·{' '}
            {pattern.phaseShare}% in the {pattern.phase}
            {pattern.timeScrambleShare !== null && pattern.timeScrambleShare > 0
              ? ` · ${pattern.timeScrambleShare}% under 20s`
              : ''}
          </div>
        </div>
        <div className="pattern-cost numeric">
          −{pattern.eloCost} elo
          <br />
          <span className="study">{open ? 'hide ↑' : 'study →'}</span>
        </div>
      </button>

      {open && (
        <div className="pattern-detail">
          <div>
            <div className="label" style={{ marginBottom: 14 }}>
              where it happened
            </div>
            <div className="pattern-examples">
              {pattern.examples.map((example) => (
                <button
                  key={`${example.gameId}-${example.ply}`}
                  type="button"
                  style={{
                    background: 'transparent',
                    border: 0,
                    padding: 0,
                    textAlign: 'left',
                    display: 'block',
                  }}
                  onClick={() => onOpenGame(example.gameId)}
                >
                  <Board
                    fen={example.fenBefore}
                    move={example.uci}
                    bestMove={example.bestMoveUci}
                    flipped={example.playerColor === 'black'}
                  />
                  <div className="meta" style={{ marginTop: 8 }}>
                    <b style={{ color: 'var(--ink)' }}>
                      {example.moveNumber}. {example.san}
                    </b>
                    {example.bestMoveSan ? ` instead of ${example.bestMoveSan}` : ''}
                    <br />
                    vs {example.opponent} · {formatDate(example.endTime)} · {example.timeClass}
                    {example.clockAfter !== null ? ` · ${formatClock(example.clockAfter)} left` : ''}
                    <br />
                    <span style={{ color: 'var(--vermilion)' }}>
                      −{example.winPercentLoss.toFixed(0)}% winning chances
                    </span>
                  </div>
                </button>
              ))}
            </div>
          </div>

          <aside className="ink-panel">
            <div className="label">best follow-up</div>
            <div className="coach-prose" style={{ marginTop: 12 }}>
              {note?.drill ?? pattern.suggestion}
            </div>
            <div
              className="meta"
              style={{
                marginTop: 18,
                paddingTop: 14,
                borderTop: '1px solid rgba(232,226,212,.2)',
                color: 'rgba(232,226,212,.6)',
              }}
            >
              {pattern.blunders} blunders · {pattern.mistakes} mistakes ·{' '}
              {pattern.inaccuracies} inaccuracies
              <br />
              average cost {pattern.averageWinPercentLoss.toFixed(1)}% of winning chances
              {pattern.topOpening
                ? ` · most often in ${pattern.topOpening.eco} (${pattern.topOpening.count}×)`
                : ''}
            </div>
            {(() => {
              // Knowing the leak is half of it; the other half is somewhere to go and
              // read about it, which is the one thing this app cannot supply itself.
              const lesson = lessonFor(pattern.motif);
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
          </aside>
        </div>
      )}
    </div>
  );
}
