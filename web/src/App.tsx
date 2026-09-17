import { useCallback, useEffect, useState } from 'react';
import { Navigate, Route, Routes, useNavigate } from 'react-router-dom';
import { api } from './api';
import { Masthead } from './components/Chrome';
import { Dashboard } from './screens/Dashboard';
import { Import } from './screens/Import';
import { Library } from './screens/Library';
import { Patterns } from './screens/Patterns';
import { Review } from './screens/Review';
import { Settings } from './screens/Settings';
import type { Scope } from './types';

const ACTIVE_PLAYER_KEY = 'chesscoach.player';
const SCOPE_KEY = 'chesscoach.scope';

export function App() {
  const navigate = useNavigate();
  const [username, setUsername] = useState<string | null>(() =>
    localStorage.getItem(ACTIVE_PLAYER_KEY),
  );
  const [scope, setScope] = useState<Scope>(
    () => (localStorage.getItem(SCOPE_KEY) as Scope | null) ?? 'all',
  );
  const [engine, setEngine] = useState<string>();
  const [checked, setChecked] = useState(false);

  useEffect(() => {
    api
      .health()
      .then((health) => setEngine(health.engine))
      .catch(() => undefined);
  }, []);

  // The stored username may be stale (database reset, different machine), so the
  // player list is the source of truth on boot.
  const refreshPlayers = useCallback(async () => {
    try {
      const { players } = await api.players();
      const stored = localStorage.getItem(ACTIVE_PLAYER_KEY);
      const match = players.find((player) => player.username === stored);
      const next = match?.username ?? players[0]?.username ?? null;
      setUsername(next);
      if (next) localStorage.setItem(ACTIVE_PLAYER_KEY, next);
      else localStorage.removeItem(ACTIVE_PLAYER_KEY);
    } catch {
      setUsername(null);
    } finally {
      setChecked(true);
    }
  }, []);

  useEffect(() => {
    void refreshPlayers();
  }, [refreshPlayers]);

  const selectPlayer = useCallback((next: string) => {
    setUsername(next);
    localStorage.setItem(ACTIVE_PLAYER_KEY, next);
  }, []);

  const changeScope = useCallback((next: Scope) => {
    setScope(next);
    localStorage.setItem(SCOPE_KEY, next);
  }, []);

  const onImported = useCallback(
    (imported: string) => {
      selectPlayer(imported);
    },
    [selectPlayer],
  );

  return (
    <div className="sheet">
      <Masthead username={username} />
      <Routes>
        <Route
          path="/"
          element={
            checked && !username ? (
              <Navigate to="/import" replace />
            ) : (
              <Dashboard
                username={username}
                scope={scope}
                onScopeChange={changeScope}
                engine={engine}
              />
            )
          }
        />
        <Route
          path="/library"
          element={<Library username={username} scope={scope} onScopeChange={changeScope} />}
        />
        <Route path="/review/:id" element={<Review />} />
        <Route
          path="/patterns"
          element={<Patterns username={username} scope={scope} onScopeChange={changeScope} />}
        />
        <Route path="/import" element={<Import onImported={onImported} />} />
        <Route
          path="/settings"
          element={
            <Settings
              activeUsername={username}
              onSelect={(next) => {
                selectPlayer(next);
                navigate('/');
              }}
              onChanged={refreshPlayers}
            />
          }
        />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </div>
  );
}
