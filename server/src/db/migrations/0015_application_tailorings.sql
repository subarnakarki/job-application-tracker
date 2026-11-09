-- 0015_application_tailorings: a resume tailored to one application (Phase 18c). The suggestions
-- and the posting's keywords from the last "Tailor my resume", the posting text they came from, and
-- the version the owner saved (its text, its edits as original/new pairs, and which resume it came
-- from). Kept apart from applications, so saving a version does not touch the application's
-- version or its follow-up clock. Deleted with the application. Additive only: a new table.

create table application_tailorings (
  application_id uuid primary key,
  user_id uuid not null,
  -- The suggestions (Phase 16 shape: edits, notCovered, model, createdAt); null until tailored.
  tailoring jsonb constraint application_tailorings_tailoring_check
    check (tailoring is null or jsonb_typeof(tailoring) = 'object'),
  -- The posting's keywords, [{ term, group }], for the fit score as the text is edited.
  keywords jsonb not null default '[]'
    constraint application_tailorings_keywords_check check (jsonb_typeof(keywords) = 'array'),
  posting_text text constraint application_tailorings_posting_text_check
    check (length(posting_text) <= 20000),
  -- The saved version; null until saved.
  tailored_text text constraint application_tailorings_tailored_text_check
    check (length(tailored_text) between 1 and 60000),
  edits jsonb constraint application_tailorings_edits_check
    check (edits is null or jsonb_typeof(edits) = 'array'),
  resume_sha256 text constraint application_tailorings_resume_sha256_check
    check (resume_sha256 ~ '^[0-9a-f]{64}$'),
  saved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint application_tailorings_saved_check
    check ((tailored_text is null) = (saved_at is null) and (tailored_text is null) = (edits is null)),
  constraint application_tailorings_application_fk foreign key (user_id, application_id)
    references applications (user_id, id) on delete cascade
);

create index application_tailorings_user_idx on application_tailorings (user_id);
