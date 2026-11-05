-- 0003_history_sequence: a deterministic order for history rows written at the same instant.
--
-- Two status changes can share occurred_at and recorded_at (always, under a frozen
-- test clock), and then the order fell through to the random uuid. An identity
-- column records insertion order; queries sort by (occurred_at, seq).
-- Additive: existing rows are numbered, nothing else changes.

alter table status_history add column seq bigint generated always as identity;

create index status_history_application_order_idx on status_history (application_id, occurred_at, seq);
