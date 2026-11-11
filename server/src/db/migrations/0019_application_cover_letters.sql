-- 0019_application_cover_letters: a cover letter for one application (Phase 23). The last draft,
-- with the posting, steer line, length and tone it was drafted from and the resume it used; saved
-- once the owner keeps it (saved_at). A letter copied from a queue job when it is tracked has no
-- resume hash. Kept apart from applications, so drafting or saving does not touch the
-- application's version or its follow-up clock. Deleted with the application. Additive only: a
-- new table.

create table application_cover_letters (
  application_id uuid primary key,
  user_id uuid not null,
  letter text not null constraint application_cover_letters_letter_check
    check (length(letter) between 1 and 5000),
  posting_text text constraint application_cover_letters_posting_text_check
    check (length(posting_text) <= 20000),
  steer text constraint application_cover_letters_steer_check check (length(steer) <= 300),
  length text not null constraint application_cover_letters_length_check
    check (length in ('short', 'standard')),
  tone text not null constraint application_cover_letters_tone_check
    check (tone in ('professional', 'warm', 'enthusiastic', 'direct')),
  resume_sha256 text constraint application_cover_letters_resume_sha256_check
    check (resume_sha256 ~ '^[0-9a-f]{64}$'),
  drafted_at timestamptz not null default now(),
  saved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint application_cover_letters_application_fk foreign key (user_id, application_id)
    references applications (user_id, id) on delete cascade
);

create index application_cover_letters_user_idx on application_cover_letters (user_id);
