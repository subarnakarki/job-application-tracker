-- 0009_job_search: the scheduled job search (Phase 15). Additive only (three new tables), so it is safe to
-- deploy before the code that uses it.

-- The setup, saved once: contact details, standard answers, queries and schedule. Validated by the app
-- (JobSearchProfileSchema) on the way in and out, so it is stored as one document.
create table job_search_profiles (
  user_id uuid primary key references users (id) on delete cascade,
  profile jsonb not null constraint job_search_profiles_profile_check check (jsonb_typeof(profile) = 'object'),
  confirmed_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- One search: by the schedule or by hand.
create table job_search_runs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users (id) on delete cascade,
  trigger text not null constraint job_search_runs_trigger_check check (trigger in ('schedule', 'manual')),
  status text not null default 'running'
    constraint job_search_runs_status_check check (status in ('running', 'done', 'failed')),
  -- The user's local date when it started: a scheduled run happens at most once per local day.
  local_day date not null,
  searches integer not null default 0 check (searches >= 0),
  error text constraint job_search_runs_error_check check (length(error) <= 500),
  started_at timestamptz not null default now(),
  finished_at timestamptz
);
create index job_search_runs_user_idx on job_search_runs (user_id, started_at desc);
-- At most one run at a time per user.
create unique index job_search_runs_one_running on job_search_runs (user_id) where status = 'running';

-- One job a search found. A job is kept once per user (by board and job id), so later runs never show it
-- again. Nothing here is ever sent to an employer by the server.
create table job_search_hits (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users (id) on delete cascade,
  run_id uuid not null references job_search_runs (id) on delete cascade,
  source text not null constraint job_search_hits_source_check
    check (source in ('greenhouse', 'lever', 'ashby', 'workday')),
  board text not null constraint job_search_hits_board_check check (length(board) between 1 and 100),
  job_id text not null constraint job_search_hits_job_id_check check (length(job_id) between 1 and 200),
  job_link text not null constraint job_search_hits_job_link_check check (length(job_link) <= 2000),
  apply_link text not null constraint job_search_hits_apply_link_check check (length(apply_link) <= 2000),
  company text not null constraint job_search_hits_company_check check (length(company) between 1 and 200),
  role text not null constraint job_search_hits_role_check check (length(role) between 1 and 200),
  location text constraint job_search_hits_location_check check (length(location) <= 200),
  work_mode text constraint job_search_hits_work_mode_check check (work_mode in ('Remote', 'Hybrid', 'On-site')),
  posted_at timestamptz,
  kind text not null constraint job_search_hits_kind_check
    check (kind in ('target', 'keyword_only', 'finish_yourself', 'skipped')),
  reason text not null constraint job_search_hits_reason_check check (length(reason) <= 300),
  -- Where the job is in the apply flow.
  state text not null default 'new' constraint job_search_hits_state_check
    check (state in ('new', 'ready', 'needs_you', 'applied', 'blocked', 'skipped')),
  -- The posting's application questions, as read from the board (null: the board does not publish them).
  questions jsonb,
  -- The drafted answers and cover letter (null until drafted).
  draft jsonb,
  draft_error text constraint job_search_hits_draft_error_check check (length(draft_error) <= 300),
  block_reason text constraint job_search_hits_block_reason_check check (length(block_reason) <= 500),
  application_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint job_search_hits_job_key unique (user_id, source, board, job_id),
  -- An applied job points at the application it created, only within the same user; deleting the
  -- application keeps the hit (and its "applied" state) without the link.
  constraint job_search_hits_application_fk foreign key (user_id, application_id)
    references applications (user_id, id) on delete set null (application_id)
);
create index job_search_hits_run_idx on job_search_hits (run_id);
create index job_search_hits_queue_idx on job_search_hits (user_id, state) where kind = 'target';
