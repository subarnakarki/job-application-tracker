import { describe, expect, it } from 'vitest';
import { strategyFor } from './strategy';

const ORIGIN = 'https://tracker.example';
const get = (path: string, mode = 'cors', method = 'GET', origin = ORIGIN) =>
  strategyFor({ method, url: `${origin}${path}`, mode, origin: ORIGIN });

describe('service worker strategy', () => {
  it('never caches the API, other origins or writes', () => {
    expect(get('/api/applications')).toBe('network-only');
    expect(get('/api/me', 'navigate')).toBe('network-only'); // e.g. the CSV export link
    expect(get('/api')).toBe('network-only');
    expect(get('/applications', 'navigate', 'POST')).toBe('network-only');
    expect(get('/assets/x.js', 'cors', 'GET', 'https://cdn.example')).toBe('network-only');
    expect(get('/sw.js')).toBe('network-only');
  });

  it('pages come from the network first, build files from the cache, the rest refreshes in the background', () => {
    expect(get('/', 'navigate')).toBe('network-first-shell');
    expect(get('/applications/123', 'navigate')).toBe('network-first-shell');
    expect(get('/assets/index-abc123.js')).toBe('cache-first');
    expect(get('/icons/icon-192.png')).toBe('stale-while-revalidate');
    expect(get('/manifest.webmanifest')).toBe('stale-while-revalidate');
    expect(get('/apiary', 'navigate')).toBe('network-first-shell'); // only /api and /api/... are the API
  });
});
