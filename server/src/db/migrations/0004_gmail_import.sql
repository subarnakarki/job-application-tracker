-- 0004_gmail_import: Gmail import runs and what each email led to.
-- Additive only (new tables), so it is safe to deploy before the code that uses it.
--
-- Email bodies are never stored: only the sender, subject and date, and the
-- one-sentence summary the classifier wrote.

create table import_runs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users (id) on delete cascade,
  started_at timestamptz not null,
  finished_at timestamptz,
  emails_scanned integer not null default 0 check (emails_scanned >= 0),
  status text not null default 'running' check (status in ('running', 'finished', 'failed'))
);
create index import_runs_user_idx on import_runs (user_id, started_at desc);

create table import_items (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references import_runs (id) on delete cascade,
  user_id uuid not null references users (id) on delete cascade,
  gmail_message_id text not null check (length(gmail_message_id) between 1 and 200),
  email_from text not null default '' check (length(email_from) <= 300),
  email_subject text not null default '' check (length(email_subject) <= 500),
  email_date timestamptz,
  verdict_kind text check (
    verdict_kind in (
      'application_confirmation', 'rejection', 'interview_invite', 'assessment', 'offer',
      'not_job_related'
    )
  ),
  confidence text check (confidence in ('high', 'medium', 'low')),
  company text check (length(company) <= 200),
  role text check (length(role) <= 200),
  summary text not null default '' check (length(summary) <= 300),
  -- Why the import did what it did, e.g. "Several applications match".
  reason text not null default '' check (length(reason) <= 200),
  -- 'pending' while the email is being handled: the row is claimed first, so
  -- two overlapping runs can never apply the same email twice.
  outcome text not null check (
    outcome in ('pending', 'created', 'status_changed', 'needs_review', 'ignored', 'undone', 'dismissed')
  ),
  -- What review should do on Apply ('create' or a target status), when known.
  proposed_status text check (
    proposed_status in ('Saved', 'Applied', 'Screening', 'Interviewing', 'Offer', 'Rejected', 'Withdrawn')
  ),
  application_id uuid references applications (id) on delete set null,
  from_status text check (
    from_status in ('Saved', 'Applied', 'Screening', 'Interviewing', 'Offer', 'Rejected', 'Withdrawn')
  ),
  to_status text check (
    to_status in ('Saved', 'Applied', 'Screening', 'Interviewing', 'Offer', 'Rejected', 'Withdrawn')
  ),
  previous_date_applied date,
  -- The application's version right after the import changed it: undo is
  -- allowed only while nobody has edited it since.
  applied_version integer check (applied_version >= 1),
  created_at timestamptz not null,
  unique (user_id, gmail_message_id)
);
create index import_items_run_idx on import_items (run_id, created_at);
