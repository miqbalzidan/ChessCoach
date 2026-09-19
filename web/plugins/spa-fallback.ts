/**
 * Makes deep links survive on a static host that has never heard of this app's routes.
 *
 * The app routes on the history API, so `/settings` is a path the browser asks the
 * server for whenever someone reloads, opens a bookmark, or follows a shared link. A
 * dev server and `vite preview` both answer those with index.html and the router sorts
 * it out. **GitHub Pages does not.** There is no rewrite rule and no SPA fallback: a
 * path that is not a file on disk is a 404, so every route except the entry point
 * breaks the moment it is loaded directly rather than navigated to.
 *
 * The fix Pages itself offers is `404.html`, which it serves for exactly those misses.
 * Making it a copy of index.html means the miss boots the app, the router reads the
 * URL that was asked for, and the right screen renders. The status line stays 404,
 * which is invisible to the person and honest to a crawler.
 *
 * This is not the service worker's job. The worker answers navigations from cache and
 * does cover reloads — but only once it is installed, which is after the first visit.
 * The first visit is the one that arrives by link.
 */
import { copyFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Plugin } from 'vite';

export function spaFallback(): Plugin {
  let outDir = 'dist';

  return {
    name: 'chesscoach:spa-fallback',
    apply: 'build',

    configResolved(config) {
      outDir = config.build.outDir;
    },

    closeBundle() {
      const root = join(process.cwd(), outDir);
      const index = join(root, 'index.html');
      if (!existsSync(index)) return;
      copyFileSync(index, join(root, '404.html'));
      // eslint-disable-next-line no-console
      console.log('  404.html — deep links fall back to the app');
    },
  };
}
