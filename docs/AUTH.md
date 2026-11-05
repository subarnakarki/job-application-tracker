# Authentication and request security

Implemented in `server/src/auth/` and `server/src/http/`. Three ways in, all ending in the same session:
Google sign-in (open signup), the shared **demo** account, and the test-only sign-in.

## Google sign-in

- `GET /api/auth/google/start?next=/path` creates a random state, PKCE verifier and nonce, keeps them in a
  10-minute `__Host-oauth` cookie (HttpOnly, Secure, SameSite=Lax) and redirects to Google
  (`openid email profile`, S256 challenge).
- `GET /api/auth/google/callback` always clears that cookie, requires the returned `state` to equal it
  (constant-time; stops login CSRF), exchanges the code with the verifier, and verifies the ID token with `jose`
  against Google's keys: issuer, audience (our client id), expiry, nonce, and `email_verified`.
- Users are matched by Google `sub`, never by email; the first sign-in creates the account, later ones refresh
  email, name and picture. Any existing session in the browser (e.g. the demo) is replaced.
- Every failure redirects to `/login?error=<reason>`; details go to the log only. `next` must be a same-site path.
- Enabled only when `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` are set, and never on Vercel preview
  deployments (their URLs cannot be registered redirect URIs). The provider is injected into `buildApp`, so tests
  use a stub.

## Sessions

- Cookie `__Host-session`: `Path=/; Secure; HttpOnly; SameSite=Lax`, no `Domain`. The `__Host-` prefix makes
  browsers refuse it unless those attributes hold, so a sibling subdomain cannot plant or overwrite it.
- The token is 256 random bits. **Only its SHA-256 is stored** (`sessions.token_hash`), so a leaked database
  cannot be replayed as cookies. A token that is not exactly 43 base64url characters never reaches the database.
- 30-day lifetime, renewed (expiry pushed out, cookie refreshed) at most once an hour, with a conditional update
  so concurrent requests renew once. A session stops working at the exact instant it expires.
- A request carrying the cookie **twice** is rejected (cookie tossing). A cookie that does not resolve (expired,
  deleted, malformed) is cleared in the response.
- Sessions always use the real app clock, never a user's test clock.

## Every route declares its audience

`config: { auth: 'public' | 'user' }` is **required**. A route without it makes the app refuse to start
(`enforceRoutePolicy`). `user` routes answer `401 { error: "unauthenticated" }` without a valid session.

## Request pipeline (order is fixed)

1. **Test-route secret guard** (only when test routes are enabled): anything under `/api/test/` without the
   secret gets a plain 404, so the routes do not reveal themselves.
2. **CSRF guard** on POST/PUT/PATCH/DELETE: `Sec-Fetch-Site` must be `same-origin`; if the browser sent no such
   header, `Origin` must match `Host`; a request body must be `application/json` (otherwise 415). A request with
   neither header is not from a browser and cannot ride a victim's cookie, so it passes.
3. **Session**: cookie resolved, `request.auth` set, 401 for `user` routes without one, `request.clock` set.
4. Handler. Then `Cache-Control: no-store` is forced on every `/api/` response, overriding the handler.

Errors: 4xx carry a stable `error` code (and `issues` for validation); any 5xx is the fixed body
`{ "error": "internal_error" }`; details go to the log only.

## Rate limiting

Fixed-window counters in `rate_limits`, one atomic upsert per attempt (in-memory counters would reset on every
serverless cold start). Demo sign-in: 30 per hour per client address. The address is `x-vercel-forwarded-for`
**only when `VERCEL=1`**; elsewhere the socket address, because a client could forge the header.

## Test-only routes (end-to-end tests)

`POST /api/test/login` (new synthetic user + session), `POST /api/test/clock`, `GET /api/test/now`,
`POST /api/test/cleanup`. They are registered only when **all** hold: `ENABLE_TEST_ROUTES=1`, `NODE_ENV=test` or
`VERCEL_ENV=preview`, **not** `VERCEL_ENV=production`, and `TEST_ROUTES_SECRET` is at least 16 characters; every
request must send it as `x-test-secret`. Synthetic users have identity provider `test` and subject `test:<uuid>`.
Each test creates its own user, so there is nothing to reset. A user's clock (frozen or offset, `test_clocks`) is
read only when test routes are enabled and only synthetic users can change theirs.

## How this is tested

- Pure unit tests: tokens, cookies, the CSRF decision table, client address, the test-routes gate.
- Real-Postgres tests: sessions, rate limiter (including 40 simultaneous attempts), demo sign-in under concurrent
  first visits, every cookie edge case, test routes, per-user clocks.
- **Route-registry meta-test** (`server/src/routes/registry.test.ts`) walks every registered route and asserts:
  the public list equals an explicit allowlist; every `user` route is 401 for anonymous, unknown, malformed,
  wrong-name and expired cookies; every mutating route refuses cross-site, mismatched-Origin and non-JSON
  requests; every response is `no-store`; no error body leaks internals; and every `user` route with an id
  parameter is named in `ISOLATION_COVERAGE` with the test proving another user gets 404.
  **When you add an endpoint, these checks apply to it automatically. A new public route or an unclaimed id
  route fails the build until the test is updated on purpose.**
