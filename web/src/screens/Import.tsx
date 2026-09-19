import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, ApiError } from '../api';
import { estimateImport, inLocalMode, storageIsPersistent } from '../engine/local';
import { pluralise } from '../format';
import { splitPgns } from '../../../core/src/importer';
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
  const [estimate, setEstimate] = useState<{ games: number; seconds: number } | null>(null);
  /** Null until asked, and only ever false on a device that refused durable storage. */
  const [persistent, setPersistent] = useState<boolean | null>(null);
  /** A picked .pgn is held here rather than in the textarea: an exported archive can
   *  be hundreds of kilobytes, and putting that through a controlled input makes a
   *  phone crawl for no benefit — nobody reads a year of PGN in a text box. */
  const [file, setFile] = useState<{ name: string; text: string; games: number } | null>(null);
  const pollRef = useRef<number | null>(null);
  const pgnInput = useRef<HTMLInputElement>(null);

  const local = inLocalMode();
  const pgnText = file?.text ?? pgn;
  const gameCount = mode === 'pgn' ? (file?.games ?? splitPgns(pgn).length) : limit;

  /**
   * On this device, an import is minutes of its own CPU, so it says how many before
   * it starts rather than after. The number is measured here — the engine times its
   * first few positions — because a phone is not a desktop and an estimate that is
   * wrong by three times is worse than none: someone plans their evening around it.
   */
  useEffect(() => {
    if (!local || gameCount <= 0) {
      setEstimate(null);
      return;
    }
    let cancelled = false;
    // Measuring starts an engine, so it waits until the number has settled rather
    // than firing on every keystroke in the PGN box.
    const timer = window.setTimeout(async () => {
      const measured = await estimateImport(gameCount);
      if (!cancelled && measured) setEstimate({ games: gameCount, seconds: measured.seconds });
    }, 600);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [local, gameCount]);

  /**
   * Whether this device will keep what the import produces. Asked here as well as in
   * Settings because this is the screen where the loss would actually happen: an
   * import into a memory-only database runs perfectly and then evaporates, and the
   * moment to learn that is before spending the battery, not after.
   */
  useEffect(() => {
    if (!local) return;
    let live = true;
    void storageIsPersistent().then((value) => {
      if (live) setPersistent(value);
    });
    return () => {
      live = false;
    };
  }, [local]);

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
          : await api.importPgn({ username: username.trim(), pgn: pgnText });
      const created = await api.job(response.jobId);
      setJob(created.job);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Import failed to start');
    } finally {
      setSubmitting(false);
    }
  };

  const longImport = estimate !== null && estimate.seconds >= 120;

  async function onPickPgn(picked: File | undefined): Promise<void> {
    if (!picked) return;
    setError(null);
    try {
      const text = await picked.text();
      const games = splitPgns(text).length;
      if (games === 0) {
        setError(`${picked.name} has no games in it — it should be a .pgn export.`);
        return;
      }
      setFile({ name: picked.name, text, games });
    } catch {
      setError('That file could not be read.');
    }
  }

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
          {local
            ? ' your games are stored in this browser, on this device.'
            : ' the database is a file on this machine.'}
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
                {/* In local mode the panel below quotes a figure measured on this very
                    device, so a remembered average here would only contradict it. */}
                {local
                  ? 'Newest first. How long the analysis takes depends on this device — the estimate below is measured on it.'
                  : 'Newest first. Analysis takes roughly a second per game on this machine.'}
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
            <span className="field-label">pgn — paste games, or open a file</span>

            {/* The dependable path on a phone. Chess.com will hand you your whole
                archive as a .pgn download; this takes it without asking the network
                for anything, so nothing can block it. */}
            <div className="pgn-file">
              <button
                type="button"
                className="btn btn-ghost"
                disabled={busy}
                onClick={() => pgnInput.current?.click()}
              >
                open a .pgn file
              </button>
              {file && (
                <span className="pgn-file-name">
                  {file.name} — {pluralise(file.games, 'game')}
                  <button type="button" className="band-clear" onClick={() => setFile(null)}>
                    clear
                  </button>
                </span>
              )}
              <input
                ref={pgnInput}
                type="file"
                accept=".pgn,text/plain"
                style={{ display: 'none' }}
                onChange={(event) => void onPickPgn(event.target.files?.[0])}
              />
            </div>

            <textarea
              className="textarea"
              value={file ? '' : pgn}
              disabled={busy || file !== null}
              placeholder={
                file
                  ? `Using ${file.name}. Clear it to paste games instead.`
                  : '[Event "Live Chess"]\n[White "you"]\n…\n\n1. e4 e5 2. Nf3 …'
              }
              onChange={(event) => setPgn(event.target.value)}
            />
          </label>
        )}

        {local && persistent === false && !busy && (
          <div className="import-warning">
            <div className="import-warning-time">This will not be saved.</div>
            <div className="prose">
              This browser will not give the app durable storage, so the import will run,
              the analysis will be right, and all of it will disappear when you reload or
              close the tab. That happens when the page is opened over <code>http://</code>{' '}
              at an address like <code>http://192.168.1.5:5400</code>. Open it over{' '}
              <code>https://</code> instead and your games stay on this device.
            </div>
          </div>
        )}

        {longImport && !busy && (
          /* A warning, not a gate. Someone with no computer can and should press on;
             they just should not discover the length of it forty minutes in. */
          <div className="import-warning">
            <div className="import-warning-time">
              About {describeDuration(estimate!.seconds)}.
            </div>
            <div className="prose">
              {pluralise(estimate!.games, 'game')} at roughly{' '}
              {Math.round(estimate!.seconds / estimate!.games)}s each on this device. If you
              have a computer, analysing there and opening the export in Settings is around
              ten times faster and costs no battery. Otherwise this runs in the background —
              you can leave and come back, and it picks up where it stopped.
            </div>
          </div>
        )}

        <button
          type="button"
          className="btn"
          onClick={start}
          disabled={
            busy ||
            submitting ||
            !username.trim() ||
            (mode === 'pgn' && !pgnText.trim()) ||
            (mode === 'chesscom' && timeClasses.length === 0)
          }
        >
          {busy
            ? 'importing…'
            : submitting
              ? 'starting…'
              : longImport
                ? `import and analyse anyway (${describeDuration(estimate!.seconds)})`
                : 'import and analyse'}
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

/** Minutes and hours, because "2760 seconds" is not a thing anyone plans around. */
function describeDuration(seconds: number): string {
  if (seconds < 90) return `${Math.max(1, Math.round(seconds))} seconds`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return `${minutes} minutes`;
  const hours = Math.round(seconds / 360) / 10;
  return `${hours} hours`;
}
