import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, HashRouter } from 'react-router-dom';
import { App } from './App';
import { loadSnapshot } from './snapshot';
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

  createRoot(container!).render(
    <StrictMode>
      <Router>
        <App />
      </Router>
    </StrictMode>,
  );
}

void start();
