-- 0001_init: users, identities, sessions, applications and status history.
--
-- Constraints here are the last line of defence behind the zod schemas in
-- shared/. The status and source lists must match shared/src/constants.ts;
-- a test compares them. Never edit this file after it has been applied
-- (the runner checks a checksum): add a new migration instead.

create table users (
  id uuid primary key default gen_random_uuid(),
  email text not null check (length(email) between 3 and 320),
  name text check (name is null or length(name) <= 200),
  picture_url text check (
    picture_url is null or (length(picture_url) <= 2000 and picture_url ~* '^https?://')
  ),
  -- IANA name shape; offsets like '+05:00' are read with flipped signs by Postgres.
  time_zone text not null default 'UTC'
    check (time_zone ~ '^[A-Za-z][A-Za-z_]*(/[A-Za-z0-9_+-]+)*$'),
  -- The shared demo account: tighter limits, resets daily.
  is_demo boolean not null default false,
  created_at timestamptz not null default now()
);
create index users_email_idx on users (lower(email));

-- Who a user is, per sign-in provider. Users are matched on (provider, subject),
-- never on email, because emails change.
create table identities (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users (id) on delete cascade,
  provider text not null check (provider in ('google', 'demo', 'test')),
  subject text not null check (length(subject) between 1 and 255),
  created_at timestamptz not null default now(),
  unique (provider, subject),
  -- Synthetic test users are recognisable and can never collide with a real subject.
  check (provider <> 'test' or subject like 'test:%')
);
create index identities_user_idx on identities (user_id);

-- Only the SHA-256 of the session token is stored.
create table sessions (
  id uuid primary key default gen_random_uuid(),
  token_hash bytea not null unique check (length(token_hash) = 32),
  user_id uuid not null references users (id) on delete cascade,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  expires_at timestamptz not null,
  check (expires_at > created_at)
);
create index sessions_user_idx on sessions (user_id);
create index sessions_expires_idx on sessions (expires_at);

create table applications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users (id) on delete cascade,
  company text not null
    constraint applications_company_check check (length(btrim(company)) between 1 and 200),
  role text not null
    constraint applications_role_check check (length(btrim(role)) between 1 and 200),
  status text not null default 'Saved'
    constraint applications_status_check check (
      status in ('Saved', 'Applied', 'Screening', 'Interviewing', 'Offer', 'Rejected', 'Withdrawn')
    ),
  date_applied date,
  source text not null default 'Other'
    constraint applications_source_check check (
      source in ('LinkedIn', 'Indeed', 'Referral', 'Company site', 'Recruiter', 'Other')
    ),
  salary_min integer constraint applications_salary_min_check check (salary_min >= 0),
  salary_max integer constraint applications_salary_max_check check (salary_max >= 0),
  salary_currency text constraint applications_salary_currency_check check (salary_currency ~ '^[A-Z]{3}$'),
  job_link text constraint applications_job_link_check check (
    job_link is null or (length(job_link) <= 2000 and job_link ~* '^https?://')
  ),
  contact text constraint applications_contact_check check (length(contact) <= 200),
  next_step text constraint applications_next_step_check check (length(next_step) <= 500),
  next_step_date date,
  notes text not null default '' constraint applications_notes_check check (length(notes) <= 10000),
  created_at timestamptz not null default now(),
  -- Audit timestamp: every write.
  updated_at timestamptz not null default now(),
  -- The follow-up clock: only real user edits move it.
  last_activity_at timestamptz not null default now(),
  -- Optimistic locking: bumped on every real edit.
  version integer not null default 1 constraint applications_version_check check (version >= 1),
  constraint applications_salary_order check (
    salary_min is null or salary_max is null or salary_max >= salary_min
  ),
  constraint applications_salary_currency_required check (
    (salary_min is null and salary_max is null) or salary_currency is not null
  )
);
create index applications_user_activity_idx on applications (user_id, last_activity_at desc);
create index applications_user_status_idx on applications (user_id, status);
create index applications_user_updated_idx on applications (user_id, updated_at desc);

-- Append-only. `occurred_at` is when it happened (used by stats), `recorded_at`
-- is when we wrote it, so imported events can be back-dated later.
create table status_history (
  id uuid primary key default gen_random_uuid(),
  application_id uuid not null references applications (id) on delete cascade,
  from_status text
    constraint status_history_from_check check (
      from_status in ('Saved', 'Applied', 'Screening', 'Interviewing', 'Offer', 'Rejected', 'Withdrawn')
    ),
  to_status text not null
    constraint status_history_to_check check (
      to_status in ('Saved', 'Applied', 'Screening', 'Interviewing', 'Offer', 'Rejected', 'Withdrawn')
    ),
  occurred_at timestamptz not null default now(),
  recorded_at timestamptz not null default now(),
  actor text not null default 'user' check (actor in ('user', 'gmail', 'system')),
  -- A save that keeps the same status must not write a row.
  constraint status_history_changed check (from_status is distinct from to_status)
);
create index status_history_application_idx on status_history (application_id, occurred_at);
