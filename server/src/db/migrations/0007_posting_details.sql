-- 0007_posting_details: more of a job posting on an application, and suggested postings.
-- Additive only (new nullable columns and a new table), so it is safe to deploy before the code that uses it.

alter table applications
  add column location text constraint applications_location_check check (length(location) <= 200),
  add column work_mode text constraint applications_work_mode_check
    check (work_mode in ('Remote', 'Hybrid', 'On-site')),
  add column posted_on date;

-- A posting found on a company's public job board that may be this application's. Never applied by
-- itself: the user applies or dismisses it. At most one per application.
create table posting_suggestions (
  id uuid primary key default gen_random_uuid(),
  application_id uuid not null,
  user_id uuid not null,
  -- Which job board it was found on, e.g. 'greenhouse' or 'rippling'. A name, not a fixed list, so a new
  -- board needs no migration; the code decides which names exist.
  source text not null constraint posting_suggestions_source_check
    check (source ~ '^[a-z][a-z0-9-]{1,30}$'),
  job_link text not null constraint posting_suggestions_job_link_check check (length(job_link) <= 2000),
  role text constraint posting_suggestions_role_check check (length(role) <= 200),
  salary_min integer check (salary_min >= 0),
  salary_max integer check (salary_max >= 0),
  salary_currency text check (salary_currency ~ '^[A-Z]{3}$'),
  location text constraint posting_suggestions_location_check check (length(location) <= 200),
  work_mode text constraint posting_suggestions_work_mode_check
    check (work_mode in ('Remote', 'Hybrid', 'On-site')),
  posted_on date,
  created_at timestamptz not null default now(),
  constraint posting_suggestions_application_fk foreign key (user_id, application_id)
    references applications (user_id, id) on delete cascade,
  constraint posting_suggestions_application_key unique (application_id)
);
