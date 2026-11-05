-- 0002_auth_support: database-backed rate limiting and the per-user test clock.
-- Additive only (new tables), so it is safe to deploy before the code that uses it.

-- Fixed-window counters. In-memory counters would reset on every serverless
-- cold start and differ per instance, so the count lives in the database.
create table rate_limits (
  key text not null check (length(key) between 1 and 200),
  window_start timestamptz not null,
  count integer not null check (count >= 1),
  primary key (key, window_start)
);
-- Lets the cleanup job drop expired windows without scanning the table.
create index rate_limits_window_idx on rate_limits (window_start);

-- Used only by the test-only routes: lets one synthetic user live in its own
-- time (frozen at an instant, or shifted by an offset) so follow-up behaviour
-- can be tested without sleeping and without affecting any other user.
create table test_clocks (
  user_id uuid primary key references users (id) on delete cascade,
  frozen_at timestamptz,
  offset_ms bigint not null default 0
);
