-- 0008_resumes: the user's resume and its recruiter analyses (Phase 14).
-- Additive only (two new tables), so it is safe to deploy before the code that uses it.

-- One current resume per user: replacing it overwrites the row. The original file is kept (Phase 15
-- attaches it to applications); pasted text has no file.
create table resumes (
  user_id uuid primary key references users (id) on delete cascade,
  file_name text constraint resumes_file_name_check check (length(file_name) between 1 and 200),
  media_type text not null constraint resumes_media_type_check check (media_type in (
    'application/pdf',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'text/plain'
  )),
  file bytea constraint resumes_file_check check (octet_length(file) <= 2097152),
  text text not null constraint resumes_text_check check (length(text) between 1 and 60000),
  text_sha256 text not null constraint resumes_text_sha256_check check (text_sha256 ~ '^[0-9a-f]{64}$'),
  uploaded_at timestamptz not null default now(),
  -- A file goes with a file name, and pasted text has neither.
  constraint resumes_file_pair_check check ((file is null) = (file_name is null)),
  constraint resumes_text_only_check check ((media_type = 'text/plain') = (file is null))
);

-- What the recruiter analysis said about a resume. Never the resume itself: `text_sha256` only says which
-- text it was, so the same resume within a day reuses the answer.
create table resume_analyses (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users (id) on delete cascade,
  file_name text constraint resume_analyses_file_name_check check (length(file_name) <= 200),
  text_sha256 text not null constraint resume_analyses_text_sha256_check
    check (text_sha256 ~ '^[0-9a-f]{64}$'),
  result jsonb not null,
  model text not null constraint resume_analyses_model_check check (length(model) <= 100),
  created_at timestamptz not null default now()
);
create index resume_analyses_user_idx on resume_analyses (user_id, created_at desc);
