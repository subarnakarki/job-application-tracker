import type * as Https from 'node:https';
import type { RequestOptions } from 'node:https';
import type { ConnectionOptions } from 'node:tls';
import { describe, expect, it, vi } from 'vitest';

type Asked = RequestOptions & Pick<ConnectionOptions, 'ALPNProtocols'>;

/** What the fetcher asked node:https for (the request itself still goes to the real module). */
const asked = vi.hoisted(() => [] as Asked[]);

vi.mock('node:https', async (importOriginal) => {
  const real = await importOriginal<typeof Https>();
  return {
    ...real,
    request: (url: URL, options: Asked, callback: never) => {
      asked.push(options);
      return real.request(url, options, callback);
    },
  };
});

const { createPageFetcher, FetchError } = await import('./fetchPage');

describe('page fetcher over TLS', () => {
  it('names HTTP/1.1 in the handshake (ALPN), which Cloudflare requires of clients', async () => {
    // Nothing listens on port 1, so the fetch fails fast, after the request was made.
    const fetchPage = createPageFetcher({
      isAllowedAddress: () => true,
      extraPorts: ['1'],
      timeoutMs: 2_000,
    });
    await expect(fetchPage('https://127.0.0.1:1/job')).rejects.toBeInstanceOf(FetchError);
    expect(asked).toHaveLength(1);
    expect(asked[0]?.ALPNProtocols).toEqual(['http/1.1']);
  });
});
