-- 0006_interviews: interviews logged against an application (past or scheduled).
-- Additive only (a new table and a unique key over existing columns), so it is safe to deploy before the
-- code that uses it.

-- Lets an interview point at an application only together with its owner.
alter table applications add constraint applications_user_id_id_key unique (user_id, id);

create table interviews (
  id uuid primary key default gen_random_uuid(),
  application_id uuid not null,
  user_id uuid not null,
  held_on date not null,
  -- For example "Hiring manager" or "Technical round".
  label text constraint interviews_label_check check (length(label) <= 200),
  notes text not null default '' constraint interviews_notes_check check (length(notes) <= 5000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint interviews_application_fk foreign key (user_id, application_id)
    references applications (user_id, id) on delete cascade
);
create index interviews_application_idx on interviews (application_id, held_on);
