-- 0012_job_search_checks: a waiting job can be checked again on its board and closed when the board
-- says it is gone (state 'closed', with when it was last checked), and can hold a tailored-resume
-- suggestion. Additive only (a wider state check and two nullable columns), so it is safe to deploy
-- before the code that uses it.

alter table job_search_hits drop constraint job_search_hits_state_check;
alter table job_search_hits add constraint job_search_hits_state_check
  check (state in ('new', 'ready', 'needs_you', 'applied', 'blocked', 'skipped', 'closed'));

alter table job_search_hits add column checked_at timestamptz;

alter table job_search_hits add column tailoring jsonb
  constraint job_search_hits_tailoring_check check (tailoring is null or jsonb_typeof(tailoring) = 'object');
