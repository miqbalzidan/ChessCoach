import { useEffect, useState } from 'react';
import { api, ApiError } from '../api';
import { ErrorNote, Loading } from '../components/Chrome';
import { relativeTime } from '../format';
import { inSnapshotMode } from '../snapshot';
import { SnapshotSettings } from './SnapshotSettings';
import { LocalDevice } from './LocalDevice';
import type { Job, Settings as SettingsData } from '../types';

export function Settings({
  activeUsername,
  onSelect,
  onChanged,
}: {
  activeUsername: string | null;
  onSelect: (username: string) => void;
  onChanged: () => void;
}) {
  // A snapshot has no server to configure, so this screen becomes an account of the
  // file instead. Declared before the effects below so none of them ever run.
  const snapshot = inSnapshotMode();

  const [settings, setSettings] = useState<SettingsData | null>(null);
  const [depth, setDepth] = useState(16);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [job, setJob] = useState<Job | null>(null);

  useEffect(() => {
    if (snapshot) return;
    api
      .settings()
      .then((data) => {
        setSettings(data);
        setDepth(data.analysisDepth);
      })
      .catch((err: unknown) =>
        setError(err instanceof ApiError ? err.message : 'Could not load settings'),
      );
  }, [snapshot]);

  useEffect(() => {
    if (!job || job.status === 'done' || job.status === 'error') return;
    const timer = window.setInterval(async () => {
      try {
        const response = await api.job(job.id);
        setJob(response.job);
        if (response.job.status === 'done') onChanged();
      } catch {
        // Leave the last known state in place.
      }
    }, 1000);
    return () => window.clearInterval(timer);
  }, [job, onChanged]);

  if (snapshot) return <SnapshotSettings />;

  // Not an early return, deliberately. Someone with no server reaches this screen
  // precisely because there is no server — and the control that frees them from
  // needing one is on it. Hiding the whole page behind the failed request would put
  // the way out behind the problem.
  if (error || !settings) {
    return (
      <>
        {error ? <ErrorNote error={error} /> : <Loading label="loading settings" />}
        <LocalDevice onSeeded={onChanged} />
      </>
    );
  }

  const saveDepth = async (next: number) => {
    setDepth(next);
    try {
      await api.saveSettings({ analysisDepth: next });
      setStatus(`Analysis depth set to ${next}.`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save');
    }
  };

  const resync = async (username: string) => {
    setStatus(null);
    try {
      const response = await api.resync(username);
      setJob((await api.job(response.jobId)).job);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Re-sync failed');
    }
  };

  const analysePending = async (username: string) => {
    setStatus(null);
    try {
      const response = await api.analysePending(username);
      setJob((await api.job(response.jobId)).job);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not start analysis');
    }
  };

  const removeGames = async (username: string) => {
    if (!window.confirm(`Delete every stored game and analysis for ${username}?`)) return;
    try {
      await api.deleteGames(username);
      setStatus(`Removed all stored games for ${username}.`);
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not delete');
    }
  };

  return (
    <>
      <div className="headline-row">
        <h1 className="headline" style={{ fontSize: 'clamp(30px, 4vw, 54px)' }}>
          Settings.
        </h1>
        <div className="headline-aside">
          {settings.engine} × {settings.engines} processes
          <br />
          coaching layer: {settings.coaching === 'claude' ? 'Claude' : 'offline summariser'}
        </div>
      </div>

      <div className="section-head">
        <div className="label">connected accounts</div>
      </div>

      <div className="rows">
        {settings.players.length === 0 ? (
          <div className="prose" style={{ padding: '18px 0' }}>
            Nothing imported yet.
          </div>
        ) : (
          settings.players.map((player) => (
            <div
              key={player.id}
              className="row"
              style={{ gridTemplateColumns: '1fr auto', cursor: 'default' }}
            >
              <div>
                <button
                  type="button"
                  onClick={() => onSelect(player.username)}
                  style={{
                    background: 'none',
                    border: 0,
                    padding: 0,
                    font: '600 19px/1.2 var(--display)',
                    color: player.username === activeUsername ? 'var(--vermilion)' : 'var(--ink)',
                  }}
                >
                  {player.username}
                </button>
                <div className="meta" style={{ marginTop: 4 }}>
                  {player.source} · synced {relativeTime(player.last_synced_at)}
                  {player.username === activeUsername ? ' · showing on the sheet' : ''}
                </div>
              </div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <button
                  type="button"
                  className="btn btn-ghost"
                  onClick={() => resync(player.username)}
                >
                  re-sync
                </button>
                <button
                  type="button"
                  className="btn btn-ghost"
                  onClick={() => analysePending(player.username)}
                >
                  analyse pending
                </button>
                <button
                  type="button"
                  className="btn btn-ghost"
                  onClick={() => removeGames(player.username)}
                >
                  delete games
                </button>
              </div>
            </div>
          ))
        )}
      </div>

      {job && job.status !== 'done' ? (
        <div style={{ margin: '20px var(--margin) 0' }}>
          <div className="label" style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span className="spinner-dot" />
            {job.stage} {job.total > 0 ? `${job.analysed || job.imported}/${job.total}` : ''}
          </div>
        </div>
      ) : null}

      <div className="section-head">
        <div className="label">analysis depth</div>
      </div>

      <div style={{ margin: '0 var(--margin)', paddingBottom: 48, maxWidth: 620 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 18 }}>
          <div className="numeric" style={{ font: '800 62px/0.9 var(--display)' }}>
            {depth}
          </div>
          <div className="prose">
            Higher depth finds more, and costs more time. Depth 16 is a good default;
            below 12 the engine starts missing the tactics that produce the patterns.
          </div>
        </div>

        <input
          type="range"
          min={8}
          max={24}
          step={1}
          value={depth}
          onChange={(event) => saveDepth(Number(event.target.value))}
          style={{ width: '100%', marginTop: 20, accentColor: 'var(--vermilion)' }}
        />
        <div className="meta" style={{ display: 'flex', justifyContent: 'space-between' }}>
          <span>8 — fast, shallow</span>
          <span>24 — slow, thorough</span>
        </div>

        {status && (
          <div className="notice" style={{ marginTop: 24 }}>
            {status}
          </div>
        )}

        <div className="section-head" style={{ margin: '36px 0 0', padding: 0 }}>
          <div className="label">coaching layer</div>
        </div>
        <div className="prose" style={{ marginTop: 12 }}>
          {settings.coaching === 'claude'
            ? 'Claude is writing the plain-language summaries. Set COACH_MODEL to change the model.'
            : 'No ANTHROPIC_API_KEY is set, so summaries come from the offline summariser — the same numbers, fewer words. Set the key and restart the server to switch it on.'}
        </div>

        <LocalDevice onSeeded={onChanged} />
      </div>
    </>
  );
}
