/**
 * What the service worker does with each request. Pure, so it is unit-tested; the worker itself
 * (sw.ts) only carries it out.
 *
 * - `/api/` and anything not GET or not ours: left to the network, never cached (your data
 *   never sits in the cache).
 * - Page navigations: network first, so a new deploy shows on the next launch; the cached app
 *   shell when offline.
 * - Hashed build files (`/assets/`): cache first; their names change whenever their content does.
 * - Other files of ours (icons, manifest): cached copy at once, refreshed in the background.
 */
export type Strategy =
  'network-only' | 'network-first-shell' | 'cache-first' | 'stale-while-revalidate';

export function strategyFor(request: {
  method: string;
  url: string;
  mode: string;
  origin: string;
}): Strategy {
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== request.origin) return 'network-only';
  if (url.pathname === '/api' || url.pathname.startsWith('/api/')) return 'network-only';
  if (url.pathname === '/sw.js') return 'network-only';
  if (request.mode === 'navigate') return 'network-first-shell';
  if (url.pathname.startsWith('/assets/')) return 'cache-first';
  return 'stale-while-revalidate';
}

/** Bump to drop every cached file on the next activation. */
export const CACHE_NAME = 'jat-shell-v2';
export const SHELL_URL = '/index.html';
