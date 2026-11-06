import { CACHE_NAME, SHELL_URL, strategyFor } from './strategy';

/**
 * The service worker, built to /sw.js. Typed by hand (the DOM and WebWorker libraries cannot be
 * mixed in one project); only what is used here is declared.
 */
interface ExtendableEventLike extends Event {
  waitUntil(promise: Promise<unknown>): void;
}
interface FetchEventLike extends ExtendableEventLike {
  request: Request;
  respondWith(response: Promise<Response>): void;
}
interface WorkerScope {
  location: Location;
  skipWaiting(): Promise<void>;
  clients: { claim(): Promise<void> };
  addEventListener(
    type: 'install' | 'activate',
    listener: (event: ExtendableEventLike) => void,
  ): void;
  addEventListener(type: 'fetch', listener: (event: FetchEventLike) => void): void;
}

const worker = self as unknown as WorkerScope;

worker.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.add(SHELL_URL))
      .then(() => worker.skipWaiting()),
  );
});

worker.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) =>
        Promise.all(names.filter((name) => name !== CACHE_NAME).map((name) => caches.delete(name))),
      )
      .then(() => worker.clients.claim()),
  );
});

async function networkFirstShell(request: Request): Promise<Response> {
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(CACHE_NAME);
      await cache.put(SHELL_URL, response.clone());
    }
    return response;
  } catch {
    return (await caches.match(SHELL_URL)) ?? Response.error();
  }
}

async function cacheFirst(request: Request): Promise<Response> {
  const cached = await caches.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response.ok) await (await caches.open(CACHE_NAME)).put(request, response.clone());
  return response;
}

async function staleWhileRevalidate(
  request: Request,
  event: ExtendableEventLike,
): Promise<Response> {
  const cached = await caches.match(request);
  const refresh = fetch(request).then(async (response) => {
    if (response.ok) await (await caches.open(CACHE_NAME)).put(request, response.clone());
    return response;
  });
  if (cached) {
    event.waitUntil(refresh.catch(() => undefined));
    return cached;
  }
  return refresh;
}

worker.addEventListener('fetch', (event) => {
  const { request } = event;
  const strategy = strategyFor({
    method: request.method,
    url: request.url,
    mode: request.mode,
    origin: worker.location.origin,
  });
  if (strategy === 'network-only') return; // the browser handles it as if there were no worker
  if (strategy === 'network-first-shell') event.respondWith(networkFirstShell(request));
  else if (strategy === 'cache-first') event.respondWith(cacheFirst(request));
  else event.respondWith(staleWhileRevalidate(request, event));
});
