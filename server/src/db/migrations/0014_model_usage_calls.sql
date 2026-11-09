-- 0014_model_usage_calls: the kind of call in model_usage is no longer a fixed list in the
-- database, so a new kind of Claude call (the LinkedIn message drafts first) needs no migration.
-- The code still writes only the kinds it knows (MODEL_CALLS in server/src/usage/record.ts).
-- Relaxes a check only, so it is safe to deploy before the code.

alter table model_usage drop constraint model_usage_call_check;
alter table model_usage add constraint model_usage_call_check
  check (call ~ '^[a-z_]{1,40}$');
