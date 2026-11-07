-- 0010_job_search_sources: a found job's board is a name, not a fixed list, so adding a job board to the
-- search needs no migration (the code decides which names exist), as for posting_suggestions in 0007.
-- Only widens what is accepted, so it is safe to deploy before the code that uses it.

alter table job_search_hits drop constraint job_search_hits_source_check;
alter table job_search_hits add constraint job_search_hits_source_check
  check (source ~ '^[a-z][a-z0-9-]{1,30}$');
