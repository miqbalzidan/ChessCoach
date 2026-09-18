import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
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
