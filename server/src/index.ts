import express from 'express';
import cors from 'cors';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { getDb } from './db-node.js';
import { createEnginePool } from './engine-node.js';
import { createApi } from './api.js';

const PORT = Number(process.env.PORT ?? 8787);

const db = getDb();
const pool = createEnginePool();

const app = express();
app.use(cors());
app.use(express.json({ limit: '25mb' }));
app.use('/api', createApi(db, pool));

// In production the built frontend is served from the same origin as the API.
const webDist = resolve(process.env.WEB_DIST ?? '../web/dist');
if (existsSync(webDist)) {
  app.use(express.static(webDist));
  app.get('*', (_req, res) => res.sendFile(resolve(webDist, 'index.html')));
}

const server = app.listen(PORT, async () => {
  console.log(`ChessCoach API on http://localhost:${PORT}`);
  await pool.ready();
  console.log(`  engine: ${pool.engineName} × ${pool.size}`);
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    server.close();
    pool.close();
    process.exit(0);
  });
}
