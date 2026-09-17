import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
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
