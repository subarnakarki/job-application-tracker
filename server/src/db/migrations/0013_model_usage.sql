-- 0013_model_usage: one row per Claude API call, to measure what each kind of call costs. Counts
-- only: no user, no prompt or answer text. Additive only (a new table), so it is safe to deploy
-- before the code that writes to it.

create table model_usage (
  id uuid primary key default gen_random_uuid(),
  call text not null constraint model_usage_call_check check (
    call in ('job_search', 'draft', 'tailor', 'classify_email', 'posting_keywords', 'resume_analysis')
  ),
  model text not null constraint model_usage_model_check check (length(model) between 1 and 100),
  input_tokens integer not null constraint model_usage_input_tokens_check check (input_tokens >= 0),
  cache_write_tokens integer not null default 0
    constraint model_usage_cache_write_tokens_check check (cache_write_tokens >= 0),
  cache_read_tokens integer not null default 0
    constraint model_usage_cache_read_tokens_check check (cache_read_tokens >= 0),
  output_tokens integer not null constraint model_usage_output_tokens_check check (output_tokens >= 0),
  web_searches integer not null default 0
    constraint model_usage_web_searches_check check (web_searches >= 0),
  created_at timestamptz not null default now()
);

create index model_usage_created_idx on model_usage (created_at);
