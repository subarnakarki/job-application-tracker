create table if not exists spike_ping (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now()
);
