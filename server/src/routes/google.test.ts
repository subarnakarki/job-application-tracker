import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GoogleSignInError, type GoogleProfile, type GoogleProvider } from '../auth/google';
import { OAUTH_COOKIE } from '../auth/oauthState';
import { SESSION_COOKIE } from '../auth/cookies';
import { createTestApp, sessionTokenFrom, setCookies, type TestApp } from '../test/app';
import { TEST_DATABASE_URL } from '../test/testDb';

const ADA: GoogleProfile = {
  subject: 'google-sub-ada',
  email: 'ada@example.com',
  name: 'Ada Lovelace',
  pictureUrl: null,
};

/** A fake Google: records what it was asked, answers with `profile` (or rejects). */
function stubGoogle() {
  const calls: { redirectUri: string; codeVerifier: string; nonce: string }[] = [];
  let next: GoogleProfile | Error = ADA;
  const provider: GoogleProvider = {
    authorizationUrl: ({ state, nonce, codeChallenge, redirectUri }) =>
      `https://accounts.example/auth?${new URLSearchParams({ state, nonce, codeChallenge, redirectUri }).toString()}`,
    exchangeCode: ({ redirectUri, codeVerifier, nonce }) => {
      calls.push({ redirectUri, codeVerifier, nonce });
      return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
    },
  };
  return { provider, calls, answer: (value: GoogleProfile | Error) => (next = value) };
}

function cookieValue(cookies: string[], name: string): string {
  return cookies.find((c) => c.startsWith(`${name}=`))?.split(';')[0] ?? '';
}

describe.skipIf(!TEST_DATABASE_URL)('Google sign-in routes', () => {
  let t: TestApp;
  let google: ReturnType<typeof stubGoogle>;

  beforeEach(async () => {
    google = stubGoogle();
    t = await createTestApp({ google: google.provider });
  });
  afterEach(() => t.close());

  async function start(next = '/applications/new') {
    const response = await t.app.inject({
      method: 'GET',
      url: `/api/auth/google/start?next=${encodeURIComponent(next)}`,
      headers: { host: 'tracker.test' },
    });
    expect(response.statusCode).toBe(302);
    const location = new URL(response.headers.location as string);
    return { location, cookie: cookieValue(setCookies(response), OAUTH_COOKIE) };
  }

  const callback = (query: string, cookie: string) =>
    t.app.inject({
      method: 'GET',
      url: `/api/auth/google/callback?${query}`,
      headers: { host: 'tracker.test', cookie },
    });

  it('signs a new Google user up, then back in as the same user', async () => {
    const first = await start();
    expect(first.location.searchParams.get('redirectUri')).toBe(
      'http://tracker.test/api/auth/google/callback',
    );
    const state = first.location.searchParams.get('state') ?? '';
    const done = await callback(`code=abc&state=${state}`, first.cookie);

    expect(done.statusCode).toBe(302);
    expect(done.headers.location).toBe('/applications/new');
    const token = sessionTokenFrom(done);
    expect(token).toBeTruthy();
    // The pending sign-in is single use.
    expect(setCookies(done).some((c) => c.startsWith(`${OAUTH_COOKIE}=;`))).toBe(true);
    // The nonce sent to Google is the one the ID token is checked against.
    expect(google.calls[0]?.nonce).toBe(first.location.searchParams.get('nonce'));

    const me = await t.app.inject({
      method: 'GET',
      url: '/api/me',
      headers: { cookie: `${SESSION_COOKIE}=${token}` },
    });
    expect(me.json()).toMatchObject({
      user: { email: 'ada@example.com', name: 'Ada Lovelace', isDemo: false },
    });

    // Second sign-in (new email at Google): same account, details refreshed.
    google.answer({ ...ADA, email: 'ada@new.example' });
    const again = await start('/');
    await callback(`code=def&state=${again.location.searchParams.get('state')}`, again.cookie);
    const users = await t.db.query<{ email: string }>(
      "select u.email from users u join identities i on i.user_id = u.id where i.provider = 'google'",
    );
    expect(users.rows).toEqual([{ email: 'ada@new.example' }]);
  });

  it('refuses a callback whose state does not match this browser (login CSRF)', async () => {
    const mine = await start();
    const done = await callback('code=abc&state=' + 'x'.repeat(43), mine.cookie);
    expect(done.headers.location).toBe('/login?error=google_expired');
    expect(sessionTokenFrom(done)).toBeNull();
    expect(google.calls).toHaveLength(0);

    const noCookie = await callback(
      `code=abc&state=${mine.location.searchParams.get('state')}`,
      '',
    );
    expect(noCookie.headers.location).toBe('/login?error=google_expired');
  });

  it('ends on the sign-in page when Google rejects or the user cancels', async () => {
    google.answer(new GoogleSignInError('bad token'));
    const attempt = await start();
    const done = await callback(
      `code=abc&state=${attempt.location.searchParams.get('state')}`,
      attempt.cookie,
    );
    expect(done.headers.location).toBe('/login?error=google_failed');
    expect(sessionTokenFrom(done)).toBeNull();

    const cancelled = await callback('error=access_denied', '');
    expect(cancelled.headers.location).toBe('/login?error=google_cancelled');
  });

  it('never redirects to another site after sign-in', async () => {
    for (const next of ['https://evil.example', '//evil.example', '/\\evil.example']) {
      const attempt = await start(next);
      const done = await callback(
        `code=abc&state=${attempt.location.searchParams.get('state')}`,
        attempt.cookie,
      );
      expect(done.headers.location).toBe('/');
    }
  });
});

describe.skipIf(!TEST_DATABASE_URL)('Google sign-in when not configured', () => {
  it('sends the browser back to the sign-in page', async () => {
    const t = await createTestApp();
    const response = await t.app.inject({ method: 'GET', url: '/api/auth/google/start' });
    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe('/login?error=google_unavailable');
    await t.close();
  });
});
