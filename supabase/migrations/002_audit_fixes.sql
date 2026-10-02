-- ===========================================================================
-- RelayPay Support Agent — migration 002 (QA audit fixes)
--
-- Apply after 001_init.sql: Supabase Dashboard → SQL Editor → paste & run.
-- Safe to re-run. The application tolerates the pre-002 schema (it falls
-- back gracefully), but these changes make the audit trail accurate:
--
--   * conversation_turns.answer_type gains 'closing' so farewells are no
--     longer recorded as knowledge answers.
--   * evaluations.run_id groups the records of one `npm run evaluate` run,
--     so the latest run can be shown without older runs mixed in.
--   * conversations.final_status defaults to 'active' for open sessions.
-- ===========================================================================

alter table public.conversation_turns
  drop constraint if exists conversation_turns_answer_type_check;
alter table public.conversation_turns
  add constraint conversation_turns_answer_type_check check (answer_type in
    ('knowledge', 'clarification', 'lookup', 'ticket', 'escalation', 'decline', 'closing', 'error'));

alter table public.evaluations
  add column if not exists run_id text;
create index if not exists idx_evaluations_run
  on public.evaluations (run_id, created_at);

alter table public.conversations
  alter column final_status set default 'active';
update public.conversations
  set final_status = 'active'
  where final_status is null and ended_at is null;
