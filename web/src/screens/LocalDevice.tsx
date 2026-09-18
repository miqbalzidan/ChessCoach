/**
 * Running the whole thing on this device, and starting it from a computer's work.
 *
 * Two controls, and the order matters. Turning local mode on makes this browser the
 * whole app — engine, database and all. Seeding then fills it from an export, which
 * is what makes it pleasant: the computer already analysed the back archive at a
 * depth this device would not attempt, and those games come across as they are.
 *
 * Analysing an archive here instead is possible and nobody is stopped from doing it.
 * It is just an afternoon and a flat battery, so the screen says so before rather
 * than after.
 */
import { useRef, useState } from 'react';
import { inLocalMode, seedFromFile, setLocalMode } from '../engine/local';
import { readSnapshotFile } from '../snapshot';
import { pluralise } from '../format';

export function LocalDevice({ onSeeded }: { onSeeded: () => void }) {
  const [local, setLocal] = useState(inLocalMode);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  function toggle(next: boolean): void {
    setLocalMode(next);
    setLocal(next);
    // Everything below the transport seam is decided once, at boot. Reloading is
    // both the simplest way to switch and the only honest one.
    window.location.reload();
  }

  async function onPick(file: File | undefined): Promise<void> {
    if (!file) return;
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const snapshot = await readSnapshotFile(file);
      const result = await seedFromFile(snapshot);
      setMessage(
        `Took ${pluralise(result.games, 'game')} from ${result.player}` +
          (result.duplicates > 0 ? `, skipping ${result.duplicates} already here` : '') +
          '. Nothing was re-analysed — these arrived already done.',
      );
      onSeeded();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'That file could not be read.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="section-head" style={{ marginTop: 36 }}>
        <div className="label">this device</div>
        <div className="meta">{local ? 'analysing here' : 'using a server'}</div>
      </div>

      <div className="prose snapshot-body">
        {local ? (
          <>
            This browser is the whole app: Stockfish runs in it and your games are stored
            on this device. Nothing is uploaded, and nothing needs a computer to be
            switched on.
          </>
        ) : (
          <>
            Turn this on and the app stops needing a server — Stockfish runs in this
            browser and your games are stored here. Useful on a phone with no computer
            behind it; slower than a desktop, so a big archive is better analysed there
            and brought over.
          </>
        )}
      </div>

      <div className="snapshot-actions">
        <button type="button" className="btn" onClick={() => toggle(!local)}>
          {local ? 'use a server instead' : 'run everything on this device'}
        </button>
      </div>

      {local && (
        <>
          <div className="section-head" style={{ marginTop: 36 }}>
            <div className="label">start from a computer's export</div>
          </div>
          <div className="prose snapshot-body">
            Open a <code>.leaksheet.json.gz</code> and its games become this device's own
            — already analysed, at the depth the computer used. This is the quick way to
            begin: the alternative is analysing the same games here, which works but
            takes hours rather than seconds. Opening a newer export later adds only the
            games played since.
          </div>

          <div className="snapshot-actions">
            <button
              type="button"
              className="btn"
              onClick={() => fileInput.current?.click()}
              disabled={busy}
            >
              {busy ? 'reading…' : 'open an export'}
            </button>
            <input
              ref={fileInput}
              type="file"
              accept=".gz,.json,application/gzip,application/json"
              style={{ display: 'none' }}
              onChange={(event) => void onPick(event.target.files?.[0])}
            />
          </div>
        </>
      )}

      {message && (
        <div className="prose snapshot-body" style={{ marginTop: 14 }}>
          {message}
        </div>
      )}
      {error && (
        <div className="prose snapshot-body" style={{ marginTop: 14, color: 'var(--vermilion)' }}>
          {error}
        </div>
      )}
    </>
  );
}
