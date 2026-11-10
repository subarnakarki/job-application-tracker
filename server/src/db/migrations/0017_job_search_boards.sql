-- 0017_job_search_boards: the company boards a user's job search watches, so every one can be read
-- each hour (the least recently read first) and a company can be added by hand. Filled from the
-- boards of the jobs found so far. A run can also be a 'sweep': the hourly reading of those boards,
-- recorded only when it finds a new job. Additive only (a new table and a wider check), so it is
-- safe to deploy before the code that uses it.

create table job_search_boards (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users (id) on delete cascade,
  source text not null constraint job_search_boards_source_check check (length(source) between 1 and 40),
  board text not null constraint job_search_boards_board_check check (length(board) between 1 and 100),
  -- Found by a search, or added by the user.
  added_by text not null constraint job_search_boards_added_by_check check (added_by in ('search', 'user')),
  created_at timestamptz not null default now(),
  last_swept_at timestamptz,
  last_error text constraint job_search_boards_last_error_check check (length(last_error) <= 300),
  constraint job_search_boards_unique unique (user_id, source, board)
);
-- The next boards to read: never read first, then the oldest reading.
create index job_search_boards_sweep_idx on job_search_boards (user_id, last_swept_at nulls first);

insert into job_search_boards (user_id, source, board, added_by, created_at)
select user_id, source, board, 'search', min(created_at)
from job_search_hits
group by user_id, source, board;

alter table job_search_runs drop constraint job_search_runs_trigger_check;
alter table job_search_runs add constraint job_search_runs_trigger_check
  check (trigger in ('schedule', 'manual', 'sweep'));
