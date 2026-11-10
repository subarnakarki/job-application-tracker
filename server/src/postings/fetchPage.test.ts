import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { gzipSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPageFetcher, FetchError, type FetchOptions } from './fetchPage';

/** A local server with a handful of routes, standing in for the internet. */
let server: Server;
let port = '';
let base = '';

beforeAll(async () => {
  server = createServer((request, response) => {
    const path = request.url ?? '/';
    if (path === '/posting') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end('<html><title>Posting</title></html>');
    } else if (path === '/echo') {
      // Answers with the method and body it was sent, as JSON.
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(
          JSON.stringify({
            method: request.method,
            contentType: request.headers['content-type'] ?? null,
            body: Buffer.concat(chunks).toString('utf8'),
          }),
        );
      });
    } else if (path === '/hop') {
      response.writeHead(302, { location: '/posting' });
      response.end();
    } else if (path === '/loop') {
      response.writeHead(302, { location: '/loop' });
      response.end();
    } else if (path === '/to-metadata') {
      response.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data/' });
      response.end();
    } else if (path === '/to-file') {
      response.writeHead(302, { location: 'file:///etc/passwd' });
      response.end();
    } else if (path === '/big') {
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end('x'.repeat(5000));
    } else if (path === '/bomb') {
      response.writeHead(200, { 'content-type': 'text/html', 'content-encoding': 'gzip' });
      response.end(gzipSync(Buffer.alloc(200_000, 'a')));
    } else if (path === '/gzip') {
      response.writeHead(200, { 'content-type': 'text/html', 'content-encoding': 'gzip' });
      response.end(gzipSync('<html>compressed</html>'));
    } else if (path === '/image') {
      response.writeHead(200, { 'content-type': 'image/png' });
      response.end('png');
    } else if (path === '/slow') {
      response.writeHead(200, { 'content-type': 'text/html' });
      response.write('<html>');
      // never ends
    } else {
      response.writeHead(404, { 'content-type': 'text/html' });
      response.end('missing');
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = String((server.address() as AddressInfo).port);
  base = `http://127.0.0.1:${port}`;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});

/** Only the loopback test server is reachable; everything else stays blocked as in production. */
const local = (options: FetchOptions = {}) =>
  createPageFetcher({
    isAllowedAddress: (address) => address === '127.0.0.1',
    extraPorts: [port],
    ...options,
  });

async function failure(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof FetchError) return error.code;
    throw error;
  }
  throw new Error('expected the fetch to fail');
}

describe('page fetcher', () => {
  it('fetches a page and follows a relative redirect', async () => {
    const page = await local()(`${base}/hop`);
    expect(page).toMatchObject({
      url: `${base}/posting`,
      text: '<html><title>Posting</title></html>',
    });
  });

  it('sends a JSON POST when asked, and never follows a redirect with one', async () => {
    const posted = await local()(`${base}/echo`, { json: { limit: 20, searchText: '' } });
    expect(JSON.parse(posted.text)).toEqual({
      method: 'POST',
      contentType: 'application/json',
      body: '{"limit":20,"searchText":""}',
    });
    expect(JSON.parse((await local()(`${base}/echo`)).text)).toMatchObject({
      method: 'GET',
      body: '',
    });
    expect(await failure(local()(`${base}/hop`, { json: {} }))).toBe('http_status');
    // The address rules are the same for a POST.
    expect(await failure(createPageFetcher()(`${base}/echo`, { json: {} }))).toBe('invalid_url');
  });

  it('decodes compressed pages', async () => {
    expect((await local()(`${base}/gzip`)).text).toBe('<html>compressed</html>');
  });

  it('with the production rules, refuses the local server by address and by name', async () => {
    const production = createPageFetcher({ extraPorts: [port] });
    expect(await failure(production(`${base}/posting`))).toBe('blocked');
    expect(await failure(production(`http://localhost:${port}/posting`))).toBe('blocked');
  });

  it('re-checks every redirect: a hop to the cloud metadata address or to file: is refused', async () => {
    expect(await failure(local()(`${base}/to-metadata`))).toBe('blocked');
    expect(await failure(local()(`${base}/to-file`))).toBe('invalid_url');
  });

  it.each([
    ['ftp://example.com/job', 'invalid_url'],
    ['javascript:alert(1)', 'invalid_url'],
    ['http://user:secret@example.com/', 'invalid_url'],
    ['http://example.com:8080/', 'invalid_url'],
    ['http://[::1]/', 'blocked'],
    ['http://169.254.169.254/latest/meta-data/', 'blocked'],
    ['http://10.0.0.5/', 'blocked'],
  ])('refuses %s (%s) before connecting', async (url, code) => {
    expect(await failure(createPageFetcher()(url))).toBe(code);
  });

  it('gives up on too many redirects, too much data (even compressed), slow pages and non-pages', async () => {
    expect(await failure(local()(`${base}/loop`))).toBe('too_many_redirects');
    expect(await failure(local({ maxBytes: 1000 })(`${base}/big`))).toBe('too_large');
    expect(await failure(local({ maxBytes: 100_000 })(`${base}/bomb`))).toBe('too_large');
    expect(await failure(local({ timeoutMs: 300 })(`${base}/slow`))).toBe('timeout');
    expect(await failure(local()(`${base}/image`))).toBe('unsupported_content');
    expect(await failure(local()(`${base}/nowhere`))).toBe('http_status');
  });
});
