import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { serviceWorker } from './plugins/service-worker';
import { spaFallback } from './plugins/spa-fallback';

export default defineConfig({
  // A project page on GitHub Pages is served under /<repo>/, not the domain root, so
  // the base has to be settable at build time. Everything in the app derives its URLs
  // from this — including the engine, which would otherwise look for itself at /.
  base: process.env.BASE_PATH ?? '/',
  // spaFallback before serviceWorker: the worker enumerates dist to build its precache
  // list, and 404.html has to exist by then to be cached with everything else.
  plugins: [react(), spaFallback(), serviceWorker()],
  worker: {
    // The Worker loads SQLite and the engine with dynamic `import()`, which means
    // code-splitting, which Vite's default IIFE worker output cannot do. It is also
    // created as `{ type: 'module' }`, so ES is what it should have been either way.
    format: 'es',
  },
  optimizeDeps: {
    // sqlite-wasm loads its .wasm by a path relative to its own module. Pre-bundling
    // rewrites that module into one of Vite's own chunks, the relative path stops
    // resolving, and the fetch returns the dev server's HTML fallback — which the
    // runtime reports as `expected magic word 00 61 73 6d, found 3c 21 64 6f`, those
    // last four bytes being `<!do`. Excluding it keeps the package's own layout.
    exclude: ['@sqlite.org/sqlite-wasm'],
  },
  server: {
    port: 5173,
    // Bind every interface so the dev server is reachable from a phone on the same
    // network. The API already binds 0.0.0.0, and the client calls it at a relative
    // /api, so a LAN address works without any further configuration.
    host: true,
    proxy: {
      '/api': {
        target: process.env.API_ORIGIN ?? 'http://localhost:8787',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
});
