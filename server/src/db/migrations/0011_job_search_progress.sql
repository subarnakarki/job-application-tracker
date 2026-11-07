-- 0011_job_search_progress: how far a job search run has got (its step and counts), so the page can
-- show progress while it runs. Additive only (one nullable column), so it is safe to deploy before the
-- code that uses it.

alter table job_search_runs add column progress jsonb
  constraint job_search_runs_progress_check check (progress is null or jsonb_typeof(progress) = 'object');
