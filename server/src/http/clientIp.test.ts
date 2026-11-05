import { describe, expect, it } from 'vitest';
import { clientIp } from './clientIp';

const VERCEL = { VERCEL: '1' };

describe('clientIp', () => {
  it('uses the socket address when not on Vercel, ignoring a spoofable forwarded header', () => {
    expect(
      clientIp({
        headers: { 'x-vercel-forwarded-for': '203.0.113.9' },
        remoteAddress: '198.51.100.4',
        env: {},
      }),
    ).toBe('198.51.100.4');
  });

  it('trusts x-vercel-forwarded-for on Vercel, taking the first address', () => {
    expect(
      clientIp({
        headers: { 'x-vercel-forwarded-for': '203.0.113.9' },
        remoteAddress: '10.0.0.1',
        env: VERCEL,
      }),
    ).toBe('203.0.113.9');
    expect(
      clientIp({
        headers: { 'x-vercel-forwarded-for': '203.0.113.9, 10.1.1.1' },
        remoteAddress: '10.0.0.1',
        env: VERCEL,
      }),
    ).toBe('203.0.113.9');
    expect(
      clientIp({
        headers: { 'x-vercel-forwarded-for': ['203.0.113.9'] },
        remoteAddress: '10.0.0.1',
        env: VERCEL,
      }),
    ).toBe('203.0.113.9');
  });

  it('falls back to the socket on Vercel when the header is missing or blank', () => {
    expect(clientIp({ headers: {}, remoteAddress: '10.0.0.1', env: VERCEL })).toBe('10.0.0.1');
    expect(
      clientIp({
        headers: { 'x-vercel-forwarded-for': '  ' },
        remoteAddress: '10.0.0.1',
        env: VERCEL,
      }),
    ).toBe('10.0.0.1');
  });

  it('only trusts the header when VERCEL is exactly "1"', () => {
    for (const value of ['0', 'true', '', undefined]) {
      expect(
        clientIp({
          headers: { 'x-vercel-forwarded-for': '203.0.113.9' },
          remoteAddress: '10.0.0.1',
          env: { VERCEL: value },
        }),
      ).toBe('10.0.0.1');
    }
  });

  it('normalises IPv4-mapped IPv6 and case, so one client is one key', () => {
    expect(clientIp({ headers: {}, remoteAddress: '::ffff:203.0.113.9', env: {} })).toBe(
      '203.0.113.9',
    );
    expect(clientIp({ headers: {}, remoteAddress: '2001:DB8::1', env: {} })).toBe('2001:db8::1');
  });

  it('never returns an empty key, and never an unbounded one', () => {
    expect(clientIp({ headers: {}, remoteAddress: undefined, env: {} })).toBe('unknown');
    expect(clientIp({ headers: {}, remoteAddress: 'x'.repeat(500), env: {} })).toHaveLength(64);
  });
});
