-- 0018_workday_board_names: a watched Workday board is named by its host and site
-- ("amgen.wd1/Careers"), which is what its job list is asked by; 0017 filled them in by tenant
-- alone ("amgen"). The full names come from the links of the jobs found so far; a board whose
-- name cannot be told is dropped (a later search adds it again). Data only, and the code deployed
-- before this never reads Workday boards, so it is safe to apply first.

insert into job_search_boards (user_id, source, board, added_by, created_at)
select distinct on (user_id, name) user_id, 'workday', name, 'search', created_at
from (
  select user_id, created_at,
    substring(job_link from '^https://([a-z0-9-]+\.wd[0-9]+)\.myworkdayjobs\.com/')
      || '/'
      || substring(job_link from '^https://[^/]+/(?:[a-z]{2}(?:-[A-Za-z]{2})?/)?([A-Za-z0-9_-]+)/job/')
      as name
  from job_search_hits
  where source = 'workday'
) named
where name is not null and length(name) <= 100
order by user_id, name, created_at
on conflict (user_id, source, board) do nothing;

delete from job_search_boards
where source = 'workday' and board !~ '^[a-z0-9-]+\.wd[0-9]+/[A-Za-z0-9_-]+$';
