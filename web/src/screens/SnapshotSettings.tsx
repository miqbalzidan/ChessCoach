import { useRef, useState } from 'react';
import { formatDateTime, pluralise } from '../format';
import { activeSnapshot, clearStoredSnapshot, importSnapshotFile } from '../snapshot';

/**
 * What Settings becomes when there is no server: an account of where this sheet came
 * from, and the one control that still means something — swapping it for another one.
 *
 * Depth, resync and re-analysis all need the engine, so they are not disabled here,
 * they are absent. A control that cannot work is worse than no control.
 */
export function SnapshotSettings() {
  const snapshot = activeSnapshot();
  const fileInput = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (!snapshot) return null;

  async function onPick(file: File | undefined): Promise<void> {
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      await importSnapshotFile(file);
      // Everything downstream reads the snapshot once, at boot, so a reload is both
      // the simplest and the most honest way to switch.
      window.location.reload();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'That file is not a snapshot.');
      setBusy(false);
    }
  }

  return (
    <>
      <div className="section-head">
        <div className="label">this snapshot</div>
      </div>

      <dl className="snapshot-facts">
        <dt>player</dt>
        <dd>{snapshot.player.username}</dd>
        <dt>taken</dt>
        <dd>{formatDateTime(snapshot.generatedAt)}</dd>
        <dt>games</dt>
        <dd>{pluralise(snapshot.games.length, 'game')}</dd>
        <dt>engine</dt>
        <dd>
          {snapshot.engine} · depth {snapshot.analysisDepth}
        </dd>
        <dt>coaching</dt>
        <dd>{describeCoaching(snapshot.scopes.all.coaching?.model)}</dd>
      </dl>

      <div className="section-head" style={{ marginTop: 36 }}>
        <div className="label">another snapshot</div>
      </div>
      <div className="prose snapshot-body">
        Export again on the computer once you have played more games, then open the new{' '}
        <code>.leaksheet.json.gz</code> here. Analysis needs Stockfish and your game
        database, so it stays where they are.
      </div>

      <div className="snapshot-actions">
        <button
          type="button"
          className="btn"
          onClick={() => fileInput.current?.click()}
          disabled={busy}
        >
          {busy ? 'reading…' : 'open snapshot'}
        </button>
        <button
          type="button"
          className="btn btn-ghost"
          onClick={async () => {
            await clearStoredSnapshot();
            window.location.reload();
          }}
        >
          forget stored snapshot
        </button>
        <input
          ref={fileInput}
          type="file"
          accept=".gz,.json,application/gzip,application/json"
          style={{ display: 'none' }}
          onChange={(event) => void onPick(event.target.files?.[0])}
        />
      </div>

      {error && (
        <div className="prose snapshot-body" style={{ marginTop: 14, color: 'var(--vermilion)' }}>
          {error}
        </div>
      )}
    </>
  );
}

/** The offline summariser records itself as "offline", which reads as a mistake
 *  rather than a choice unless it is spelled out. */
function describeCoaching(model: string | undefined): string {
  if (!model) return 'not included';
  return model === 'offline' ? 'written offline, without Claude' : `written by ${model}`;
}
