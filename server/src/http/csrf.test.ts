import { describe, expect, it } from 'vitest';
import { checkRequest } from './csrf';

type Headers = Record<string, string | string[] | undefined>;
const HOST = 'app.example.com';
const JSON_BODY: Headers = { 'content-type': 'application/json', 'content-length': '12' };

const check = (method: string, headers: Headers = {}) => checkRequest({ method, headers });

describe('checkRequest: safe methods', () => {
  it.each(['GET', 'HEAD', 'OPTIONS', 'get'])(
    'never blocks %s, whatever the headers say',
    (method) => {
      expect(
        check(method, {
          'sec-fetch-site': 'cross-site',
          origin: 'https://evil.example',
          host: HOST,
        }),
      ).toEqual({
        ok: true,
      });
    },
  );
});

describe('checkRequest: Sec-Fetch-Site', () => {
  it('allows a same-origin state-changing request', () => {
    expect(check('POST', { 'sec-fetch-site': 'same-origin', host: HOST })).toEqual({ ok: true });
  });

  it.each(['cross-site', 'same-site', 'none', '', 'Same-Origin', 'anything'])(
    'refuses a state-changing request marked %j',
    (value) => {
      expect(check('POST', { 'sec-fetch-site': value, host: HOST })).toMatchObject({
        ok: false,
        statusCode: 403,
        code: 'cross_site_request',
      });
    },
  );

  it.each(['POST', 'PUT', 'PATCH', 'DELETE', 'post'])('applies to %s', (method) => {
    expect(check(method, { 'sec-fetch-site': 'cross-site' })).toMatchObject({
      ok: false,
      statusCode: 403,
    });
  });

  it('trusts Sec-Fetch-Site over a conflicting Origin (browsers set it and pages cannot forge it)', () => {
    expect(
      check('POST', { 'sec-fetch-site': 'cross-site', origin: `https://${HOST}`, host: HOST }),
    ).toMatchObject({
      ok: false,
    });
  });
});

describe('checkRequest: Origin fallback (no Sec-Fetch-Site)', () => {
  it('allows an Origin that matches the host', () => {
    expect(check('POST', { origin: `https://${HOST}`, host: HOST })).toEqual({ ok: true });
    expect(check('POST', { origin: 'http://localhost:5173', host: 'localhost:5173' })).toEqual({
      ok: true,
    });
  });

  it.each([
    ['another site', 'https://evil.example'],
    ['a sibling subdomain', 'https://other.example.com'],
    ['a look-alike prefix', 'https://app.example.com.evil.example'],
    ['a different port', 'https://app.example.com:8443'],
    ['the literal null origin', 'null'],
    ['garbage', 'not a url'],
    ['empty', ''],
  ])('refuses %s', (_label, origin) => {
    expect(check('POST', { origin, host: HOST })).toMatchObject({ ok: false, statusCode: 403 });
  });

  it('refuses any Origin when the Host header is missing', () => {
    expect(check('POST', { origin: `https://${HOST}` })).toMatchObject({
      ok: false,
      statusCode: 403,
    });
  });
});

describe('checkRequest: non-browser clients', () => {
  it("lets a request with neither header through, since it cannot carry a victim's cookie", () => {
    expect(check('POST', { host: HOST })).toEqual({ ok: true });
    expect(check('DELETE', {})).toEqual({ ok: true });
  });
});

describe('checkRequest: content type of a body', () => {
  it.each([
    ['application/json'],
    ['application/json; charset=utf-8'],
    ['Application/JSON'],
    ['application/json;charset=UTF-8'],
  ])('accepts %s', (contentType) => {
    expect(check('POST', { 'content-type': contentType, 'content-length': '5' })).toEqual({
      ok: true,
    });
  });

  it.each([
    ['text/plain'],
    ['text/plain;charset=UTF-8'],
    ['application/x-www-form-urlencoded'],
    ['multipart/form-data; boundary=x'],
    ['application/jsonp'],
    ['application/json-patch+json'],
    ['text/json'],
    [''],
  ])('refuses a body sent as %j (what a cross-site form can send)', (contentType) => {
    expect(check('POST', { 'content-type': contentType, 'content-length': '5' })).toMatchObject({
      ok: false,
      statusCode: 415,
      code: 'unsupported_media_type',
    });
  });

  it('refuses a body with no content type at all', () => {
    expect(check('POST', { 'content-length': '5' })).toMatchObject({ ok: false, statusCode: 415 });
  });

  it('refuses a chunked body that is not JSON', () => {
    expect(
      check('POST', { 'transfer-encoding': 'chunked', 'content-type': 'text/plain' }),
    ).toMatchObject({
      ok: false,
      statusCode: 415,
    });
  });

  it('does not demand a content type when there is no body', () => {
    expect(check('POST', { 'content-length': '0' })).toEqual({ ok: true });
    expect(check('DELETE', { host: HOST })).toEqual({ ok: true });
  });

  it('checks the origin before the content type', () => {
    expect(
      check('POST', {
        'sec-fetch-site': 'cross-site',
        'content-type': 'text/plain',
        'content-length': '3',
      }),
    ).toMatchObject({
      statusCode: 403,
    });
  });

  it('accepts a same-origin JSON request end to end', () => {
    expect(
      check('PATCH', {
        ...JSON_BODY,
        'sec-fetch-site': 'same-origin',
        host: HOST,
        origin: `https://${HOST}`,
      }),
    ).toEqual({
      ok: true,
    });
  });
});
