import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, ApiError } from '../api';
import { pluralise } from '../format';
import { TIME_CLASSES, type Job, type TimeClass } from '../types';

type Mode = 'chesscom' | 'pgn';

const RANGES = [
  { label: 'last 25', value: 25 },
  { label: 'last 50', value: 50 },
  { label: 'last 100', value: 100 },
  { label: 'last 300', value: 300 },
];

export function Import({ onImported }: { onImported: (username: string) => void }) {
  const navigate = useNavigate();
  const [mode, setMode] = useState<Mode>('chesscom');
  const [username, setUsername] = useState('');
  const [pgn, setPgn] = useState('');
  const [limit, setLimit] = useState(50);
  const [timeClasses, setTimeClasses] = useState<TimeClass[]>([...TIME_CLASSES]);
  const [job, setJob] = useState<Job | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const pollRef = useRef<number | null>(null);

  // Progress is polled rather than streamed: an import is a handful of stage
  // changes over minutes, which does not justify a socket.
  useEffect(() => {
    if (!job || job.status === 'done' || job.status === 'error') return;

    pollRef.current = window.setInterval(async () => {
      try {
        const response = await api.job(job.id);
        setJob(response.job);
        if (response.job.status === 'done') {
          onImported(response.job.username);
        }
      } catch {
        // Keep the last known state; the next tick may succeed.
      }
    }, 900);

    return () => {
      if (pollRef.current !== null) window.clearInterval(pollRef.current);
    };
  }, [job, onImported]);

  const start = async () => {
    setError(null);
    setSubmitting(true);
    try {
      const response =
        mode === 'chesscom'
          ? await api.importChessCom({ username: username.trim(), limit, timeClasses })
          : await api.importPgn({ username: username.trim(), pgn });
      const created = await api.job(response.jobId);
      setJob(created.job);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Import failed to start');
    } finally {
      setSubmitting(false);
    }
  };

  const toggleClass = (timeClass: TimeClass) => {
    setTimeClasses((current) =>
      current.includes(timeClass)
        ? current.filter((entry) => entry !== timeClass)
        : [...current, timeClass],
    );
  };

  const busy = job !== null && job.status !== 'done' && job.status !== 'error';

  return (
    <>
      <div className="headline-row">
        <h1 className="headline" style={{ fontSize: 'clamp(30px, 4.6vw, 64px)' }}>
          Bring in
          <br />
          your <em>games</em>.
        </h1>
        <div className="headline-aside">
          Every move is run through Stockfish locally. Nothing is uploaded anywhere;
          the database is a file on this machine.
        </div>
      </div>

      <div className="band" role="group" aria-label="Import source">
        <div className="band-label">source</div>
        <button
          type="button"
          className={`band-option${mode === 'chesscom' ? ' is-active' : ''}`}
          onClick={() => setMode('chesscom')}
        >
          Chess.com
        </button>
        <button
          type="button"
          className={`band-option${mode === 'pgn' ? ' is-active' : ''}`}
          onClick={() => setMode('pgn')}
        >
          Paste PGN
        </button>
      </div>

      <div style={{ margin: '0 var(--margin)', padding: '30px 0 40px', maxWidth: 760 }}>
        <label className="field" style={{ marginBottom: 28 }}>
          <span className="field-label">
            {mode === 'chesscom' ? 'chess.com username' : 'your name as it appears in the PGN'}
          </span>
          <input
            className="input input-hero"
            value={username}
            placeholder={mode === 'chesscom' ? 'hikaru' : 'your_username'}
            autoComplete="off"
            spellCheck={false}
            disabled={busy}
            onChange={(event) => setUsername(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && username.trim() && mode === 'chesscom') void start();
            }}
          />
        </label>

        {mode === 'chesscom' ? (
          <>
            <div style={{ marginBottom: 28 }}>
              <span className="field-label">how many games</span>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 0, border: '1px solid var(--rule)' }}>
                {RANGES.map((range) => (
                  <button
                    key={range.value}
                    type="button"
                    className={`band-option${limit === range.value ? ' is-active' : ''}`}
                    onClick={() => setLimit(range.value)}
                    disabled={busy}
                    aria-pressed={limit === range.value}
                  >
                    {range.label}
                  </button>
                ))}
              </div>
              <div className="meta" style={{ marginTop: 10 }}>
                Newest first. Analysis takes roughly a second per game on this machine.
              </div>
            </div>

            <div style={{ marginBottom: 28 }}>
              <span className="field-label">time classes</span>
              <div style={{ display: 'flex', flexWrap: 'wrap', border: '1px solid var(--rule)' }}>
                {TIME_CLASSES.map((timeClass) => (
                  <button
                    key={timeClass}
                    type="button"
                    className={`band-option${timeClasses.includes(timeClass) ? ' is-active' : ''}`}
                    onClick={() => toggleClass(timeClass)}
                    disabled={busy}
                    aria-pressed={timeClasses.includes(timeClass)}
                  >
                    {timeClass}
                  </button>
                ))}
              </div>
            </div>
          </>
        ) : (
          <label className="field" style={{ marginBottom: 28 }}>
            <span className="field-label">pgn — paste one game or a whole export</span>
            <textarea
              className="textarea"
              value={pgn}
              disabled={busy}
              placeholder={'[Event "Live Chess"]\n[White "you"]\n…\n\n1. e4 e5 2. Nf3 …'}
              onChange={(event) => setPgn(event.target.value)}
            />
          </label>
        )}

        <button
          type="button"
          className="btn"
          onClick={start}
          disabled={
            busy ||
            submitting ||
            !username.trim() ||
            (mode === 'pgn' && !pgn.trim()) ||
            (mode === 'chesscom' && timeClasses.length === 0)
          }
        >
          {busy ? 'importing…' : submitting ? 'starting…' : 'import and analyse'}
        </button>

        {error && (
          <div className="notice" style={{ marginTop: 24 }}>
            {error}
          </div>
        )}

        {job && <JobProgress job={job} onOpen={() => navigate('/')} />}
      </div>
    </>
  );
}

const STAGE_LABEL: Record<Job['stage'], string> = {
  queued: 'queued',
  fetching: 'fetching your archives from Chess.com',
  importing: 'storing games',
  analysing: 'running Stockfish over every move',
  done: 'done',
  error: 'failed',
};

function JobProgress({ job, onOpen }: { job: Job; onOpen: () => void }) {
  const done = job.stage === 'analysing' ? job.analysed : job.imported;
  const percent = job.total > 0 ? Math.round((done / job.total) * 100) : 0;

  return (
    <div style={{ marginTop: 34, borderTop: '3px solid var(--ink)', paddingTop: 20 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <div className="label">{STAGE_LABEL[job.stage]}</div>
        <div className="meta numeric">
          {job.total > 0 ? `${done} / ${job.total}` : ''}
        </div>
      </div>

      <div className="progress-track" style={{ marginTop: 12 }}>
        <div className="progress-fill" style={{ width: `${job.status === 'done' ? 100 : percent}%` }} />
      </div>

      {job.status === 'error' ? (
        <div className="notice" style={{ marginTop: 18 }}>
          {job.message ?? 'The import failed.'}
        </div>
      ) : job.status === 'done' ? (
        <div style={{ marginTop: 18, display: 'flex', alignItems: 'center', gap: 16 }}>
          <div className="prose">
            {pluralise(job.imported, 'new game')} imported and {pluralise(job.analysed, 'game')}{' '}
            analysed.
          </div>
          <button type="button" className="btn" onClick={onOpen}>
            open the sheet
          </button>
        </div>
      ) : (
        <div className="meta" style={{ marginTop: 14, display: 'flex', gap: 10, alignItems: 'center' }}>
          <span className="spinner-dot" />
          {job.message ?? 'this keeps running if you navigate away'}
        </div>
      )}
    </div>
  );
}
