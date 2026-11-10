-- 0016_job_search_draft_attempts: how many times drafting a waiting job has failed, so a job that
-- always fails stops being retried every hour (after 3 it moves to Needs you). Additive only (one
-- column with a default), so it is safe to deploy before the code that uses it.

alter table job_search_hits add column draft_attempts smallint not null default 0
  constraint job_search_hits_draft_attempts_check check (draft_attempts >= 0);
