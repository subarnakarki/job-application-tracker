-- 0005_leads: networking leads (people helping with the search) and notes from each conversation.
-- Additive only (new tables, one new nullable column), so it is safe to deploy before the code that uses it.

create table leads (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users (id) on delete cascade,
  name text not null constraint leads_name_check check (length(btrim(name)) between 1 and 200),
  company text constraint leads_company_check check (length(company) <= 200),
  email text constraint leads_email_check check (
    email is null or (length(email) <= 320 and email ~ '^[^@[:space:]]+@[^@[:space:]]+$')
  ),
  phone text constraint leads_phone_check check (length(phone) <= 50),
  profile_link text constraint leads_profile_link_check check (
    profile_link is null or (length(profile_link) <= 2000 and profile_link ~* '^https?://')
  ),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- Lets notes and applications point at a lead only together with its owner.
  constraint leads_user_id_id_key unique (user_id, id)
);
create index leads_user_name_idx on leads (user_id, lower(name));

create table lead_notes (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid not null,
  user_id uuid not null,
  held_on date not null,
  body text not null constraint lead_notes_body_check check (length(btrim(body)) between 1 and 5000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint lead_notes_lead_fk foreign key (user_id, lead_id)
    references leads (user_id, id) on delete cascade
);
create index lead_notes_lead_idx on lead_notes (lead_id, held_on desc, created_at desc);

-- An application can name the lead it came through. Deleting the lead keeps the application,
-- unlinked: only lead_id is cleared, never user_id.
alter table applications add column lead_id uuid;
alter table applications add constraint applications_lead_fk foreign key (user_id, lead_id)
  references leads (user_id, id) on delete set null (lead_id);
create index applications_lead_idx on applications (lead_id) where lead_id is not null;
