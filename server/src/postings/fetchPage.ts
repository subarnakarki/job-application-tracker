import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib';
import { isPublicAddress } from './addressGuard';

/** Why a page could not be fetched. Only the code is shown to the user; details are for the log. */
export type FetchFailure =
  | 'invalid_url'
  | 'blocked'
  | 'timeout'
  | 'too_large'
  | 'http_status'
  | 'too_many_redirects'
  | 'unsupported_content'
  | 'network';

export class FetchError extends Error {
  constructor(
    readonly code: FetchFailure,
    detail: string,
  ) {
    super(detail);
    this.name = 'FetchError';
  }
}

export interface FetchedPage {
  /** Where the last redirect led. */
  url: string;
  contentType: string;
  text: string;
}

export interface FetchOptions {
  /** For the whole fetch, redirects included. */
  timeoutMs?: number;
  /** Of the decoded body. */
  maxBytes?: number;
  maxRedirects?: number;
  /** Which resolved addresses may be connected to. Only tests widen this, to reach a local server. */
  isAllowedAddress?: (address: string) => boolean;
  /** Ports besides 80 and 443. Only tests use this, for a local server on a random port. */
  extraPorts?: string[];
}

/** Fetches a page someone pasted, safely enough to do from the server. */
export type PageFetcher = (url: string) => Promise<FetchedPage>;

const REDIRECTS = new Set([301, 302, 303, 307, 308]);
// HTML pages, JSON APIs (and JSON Feed), and the XML feeds some job boards publish.
const READABLE =
  /^(text\/html|application\/xhtml\+xml|application\/(ld\+|feed\+)?json|text\/plain|(text|application)\/xml)/i;

/** http(s) on the default ports only, with no credentials in the link. */
function checkUrl(raw: string, extraPorts: string[] = []): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new FetchError('invalid_url', 'not a URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:')
    throw new FetchError('invalid_url', `scheme ${url.protocol}`);
  if (url.username || url.password) throw new FetchError('invalid_url', 'credentials in URL');
  const port = url.port || (url.protocol === 'https:' ? '443' : '80');
  if (port !== '80' && port !== '443' && !extraPorts.includes(port))
    throw new FetchError('invalid_url', `port ${port}`);
  return url;
}

export function createPageFetcher(options: FetchOptions = {}): PageFetcher {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const maxBytes = options.maxBytes ?? 2 * 1024 * 1024;
  const maxRedirects = options.maxRedirects ?? 3;
  const allowed = options.isAllowedAddress ?? isPublicAddress;
  const extraPorts = options.extraPorts ?? [];

  /**
   * DNS lookup that refuses the whole name if any address is not allowed, and hands the socket
   * only checked addresses, so the connection goes where the check looked (no DNS rebinding).
   */
  const guardedLookup = (
    hostname: string,
    lookupOptions: { all?: boolean } | number | undefined,
    callback: (
      error: NodeJS.ErrnoException | null,
      address: string | LookupAddress[],
      family?: number,
    ) => void,
  ) => {
    dnsLookup(hostname, { all: true }, (error, addresses) => {
      if (error) return callback(error, '');
      if (addresses.length === 0 || addresses.some((entry) => !allowed(entry.address))) {
        return callback(
          new FetchError('blocked', `${hostname} resolves to a non-public address`),
          '',
        );
      }
      const wantsAll = typeof lookupOptions === 'object' && lookupOptions?.all === true;
      if (wantsAll) return callback(null, addresses);
      const first = addresses[0] as LookupAddress;
      return callback(null, first.address, first.family);
    });
  };

  const once = (url: URL, signal: AbortSignal): Promise<IncomingMessage> =>
    new Promise((resolve, reject) => {
      // An address written in the link is never looked up, so it is checked here.
      const host = url.hostname.replace(/^\[|\]$/g, '');
      if (isIP(host) !== 0 && !allowed(host)) {
        reject(new FetchError('blocked', 'non-public address in URL'));
        return;
      }
      const request = (url.protocol === 'https:' ? httpsRequest : httpRequest)(
        url,
        {
          method: 'GET',
          signal,
          lookup: guardedLookup,
          headers: {
            accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.1',
            'accept-encoding': 'gzip, deflate, br',
            'user-agent': 'JobApplicationTracker/1.0 (fill from link)',
          },
        },
        resolve,
      );
      request.on('error', reject);
      request.end();
    });

  const readBody = (response: IncomingMessage, signal: AbortSignal): Promise<string> =>
    new Promise((resolve, reject) => {
      const encoding = String(response.headers['content-encoding'] ?? '').toLowerCase();
      const stream =
        encoding === 'gzip' || encoding === 'x-gzip'
          ? response.pipe(createGunzip())
          : encoding === 'deflate'
            ? response.pipe(createInflate())
            : encoding === 'br'
              ? response.pipe(createBrotliDecompress())
              : response;
      const chunks: Buffer[] = [];
      let size = 0;
      stream.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > maxBytes) {
          response.destroy();
          reject(new FetchError('too_large', `over ${maxBytes} bytes`));
          return;
        }
        chunks.push(chunk);
      });
      stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      stream.on('error', reject);
      signal.addEventListener('abort', () => reject(new FetchError('timeout', 'deadline')), {
        once: true,
      });
    });

  return async (raw) => {
    let url = checkUrl(raw, extraPorts);
    const deadline = AbortSignal.timeout(timeoutMs);
    try {
      for (let redirects = 0; ; redirects++) {
        const response = await once(url, deadline);
        const status = response.statusCode ?? 0;
        if (REDIRECTS.has(status)) {
          response.resume();
          const location = response.headers.location;
          if (!location) throw new FetchError('http_status', `${status} without Location`);
          if (redirects >= maxRedirects) throw new FetchError('too_many_redirects', `${redirects}`);
          url = checkUrl(new URL(location, url).toString(), extraPorts);
          continue;
        }
        if (status < 200 || status > 299) {
          response.resume();
          throw new FetchError('http_status', String(status));
        }
        const contentType = String(response.headers['content-type'] ?? '');
        if (!READABLE.test(contentType)) {
          response.resume();
          throw new FetchError('unsupported_content', contentType || 'none');
        }
        return { url: url.toString(), contentType, text: await readBody(response, deadline) };
      }
    } catch (error) {
      if (error instanceof FetchError) throw error;
      if (deadline.aborted) throw new FetchError('timeout', 'deadline');
      const cause = (error as { cause?: unknown }).cause;
      if (cause instanceof FetchError) throw cause;
      throw new FetchError('network', (error as Error).message);
    }
  };
}
