import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, HashRouter } from 'react-router-dom';
import { App } from './App';
import { loadSnapshot } from './snapshot';
import { resolveLocalMode } from './engine/local';
import { API_BASE } from './api';
import './styles.css';

const container = document.getElementById('root');
if (!container) throw new Error('Missing #root');

/**
 * The snapshot has to be resolved before the first render, because it decides both
 * where the data comes from and which router can work. Opened as a file there is no
 * server to rewrite paths, so history-API routes would 404 on reload — hash routes
 * are the only ones that survive.
 */
async function start(): Promise<void> {
  const snapshot = await loadSnapshot();
  const Router = snapshot ? HashRouter : BrowserRouter;

  // Which backend answers has to be settled before the first render, for the same
  // reason the snapshot does: a screen that mounts against a server which is not
  // there shows an HTTP status instead of the app. A snapshot already answers every
  // read, so it needs nobody's opinion about servers.
  if (!snapshot) await resolveLocalMode(API_BASE);

  // A project page serves the app from /<repo>/, so the router has to be told where it
  // lives. Without this every path arrives as `/<repo>/settings`, matches none of the
  // routes, falls through to `*`, and the app redirects itself to `/` — outside its own
  // base path, where the next reload is a 404. A snapshot is a single file with no
  // paths at all, so the hash router is left alone.
  const located = snapshot ? {} : { basename: import.meta.env.BASE_URL };

  createRoot(container!).render(
    <StrictMode>
      <Router {...located}>
        <App />
      </Router>
    </StrictMode>,
  );
}

void start();

/**
 * Installing the app, so it works with no network and no computer.
 *
 * Production only: a service worker in front of a dev server serves yesterday's
 * bundle and wastes an afternoon. Registration failing is not worth surfacing — the
 * app works either way, it just will not survive going offline.
 */
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  addEventListener('load', () => {
    void navigator.serviceWorker
      .register(`${import.meta.env.BASE_URL}sw.js`, { scope: import.meta.env.BASE_URL })
      .catch(() => undefined);
  });
}
