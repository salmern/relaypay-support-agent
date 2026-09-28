-- ===========================================================================
-- RelayPay Support Agent — Supabase schema (Week 6 capstone)
--
-- How to apply:
--   Option A (recommended): Supabase Dashboard → SQL Editor → paste & run.
--   Option B: supabase CLI → `supabase db push` after linking your project.
--
-- Design notes:
--   * Seed tables use the stable IDs from assets/seed-data as PRIMARY KEYs,
--     which makes the seed pipeline idempotent (upsert-safe).
--   * Runtime tables are append-only logs keyed by generated IDs.
--   * No public access: the app uses the service role key server-side.
--     Row Level Security stays ON with no public policies, so anon/public
--     clients can read nothing even if the anon key leaks.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- Seed data: customers
-- ---------------------------------------------------------------------------
create table if not exists public.customers (
  customer_id    text primary key,
  company_name   text not null,
  contact_name   text not null,
  contact_email  text not null,
  plan           text not null,
  account_status text not null,
  region         text not null,
  kyc_status     text not null,
  support_notes  text not null default ''
);

-- ---------------------------------------------------------------------------
-- Seed data: transactions
-- ---------------------------------------------------------------------------
create table if not exists public.transactions (
  transaction_id      text primary key,
  customer_id         text not null references public.customers (customer_id),
  transaction_type    text not null,
  amount              text not null,
  currency            text not null,
  destination_country text not null,
  status              text not null,
  created_at          date not null,
  estimated_arrival   date,
  support_summary     text not null
);

-- ---------------------------------------------------------------------------
-- Seed data: payouts
-- ---------------------------------------------------------------------------
create table if not exists public.payouts (
  payout_id      text primary key,
  transaction_id text not null references public.transactions (transaction_id),
  customer_id    text not null references public.customers (customer_id),
  recipient_name text not null,
  amount         text not null,
  currency       text not null,
  status         text not null,
  scheduled_for  date not null,
  failure_reason text
);

-- ---------------------------------------------------------------------------
-- Conversations
-- ---------------------------------------------------------------------------
create table if not exists public.conversations (
  id                text primary key,
  channel           text not null check (channel in ('voice', 'text')),
  caller_identifier text,
  started_at        timestamptz not null default now(),
  ended_at          timestamptz,
  final_status      text check (final_status in ('active', 'completed', 'escalated', 'error')),
  summary           text
);

-- ---------------------------------------------------------------------------
-- Conversation turns
-- ---------------------------------------------------------------------------
create table if not exists public.conversation_turns (
  id                  bigint generated always as identity primary key,
  conversation_id     text not null references public.conversations (id),
  user_transcript     text not null,
  assistant_response  text not null,
  answer_type         text not null check (answer_type in
                        ('knowledge', 'clarification', 'lookup', 'ticket', 'escalation', 'decline', 'error')),
  confidence          numeric not null default 0.8,
  uncertainty_note    text,
  created_at          timestamptz not null default now()
);
create index if not exists idx_turns_conversation
  on public.conversation_turns (conversation_id, created_at);

-- ---------------------------------------------------------------------------
-- Retrieval logs (approved knowledge used to answer)
-- ---------------------------------------------------------------------------
create table if not exists public.retrieval_logs (
  id               bigint generated always as identity primary key,
  conversation_id  text references public.conversations (id),
  query            text not null,
  knowledge_chunks text[] not null default '{}',
  source_title     text not null,
  source_summary   text not null,
  created_at       timestamptz not null default now()
);
create index if not exists idx_retrieval_conversation
  on public.retrieval_logs (conversation_id, created_at);

-- ---------------------------------------------------------------------------
-- MCP tool-call logs (audit trail)
-- ---------------------------------------------------------------------------
create table if not exists public.tool_calls (
  id             bigint generated always as identity primary key,
  conversation_id text references public.conversations (id),
  tool_name      text not null,
  purpose        text not null,
  input_summary  text not null,
  result_summary text not null,
  status         text not null check (status in ('success', 'error')),
  error_message  text,
  created_at     timestamptz not null default now()
);
create index if not exists idx_tool_calls_conversation
  on public.tool_calls (conversation_id, created_at);

-- ---------------------------------------------------------------------------
-- Conversation events (important agent actions and decisions,
-- written through the MCP log_conversation_event tool)
-- ---------------------------------------------------------------------------
create table if not exists public.conversation_events (
  id              bigint generated always as identity primary key,
  conversation_id text not null references public.conversations (id),
  event_type      text not null,
  summary         text not null,
  metadata        jsonb not null default '{}'::jsonb,
  created_at      timestamptz not null default now()
);
create index if not exists idx_events_conversation
  on public.conversation_events (conversation_id, created_at);

-- ---------------------------------------------------------------------------
-- Support tickets
-- ---------------------------------------------------------------------------
create table if not exists public.support_tickets (
  ticket_id       text primary key,
  customer_id     text references public.customers (customer_id),
  transaction_id  text references public.transactions (transaction_id),
  conversation_id text not null references public.conversations (id),
  category        text not null,
  priority        text not null,
  summary         text not null,
  status          text not null default 'open' check (status in ('open', 'in_progress', 'closed')),
  created_at      timestamptz not null default now()
);
create index if not exists idx_tickets_conversation
  on public.support_tickets (conversation_id, created_at);

-- ---------------------------------------------------------------------------
-- Escalations
-- ---------------------------------------------------------------------------
create table if not exists public.escalations (
  escalation_id   text primary key,
  ticket_id       text references public.support_tickets (ticket_id),
  customer_id     text references public.customers (customer_id),
  conversation_id text not null references public.conversations (id),
  user_name       text,
  user_email      text,
  category        text not null check (category in ('compliance', 'account', 'dispute', 'payment', 'other')),
  reason          text not null,
  call_booked     boolean not null default false,
  preferred_time  text,
  status          text not null default 'open' check (status in ('open', 'in_progress', 'closed')),
  created_at      timestamptz not null default now()
);
create index if not exists idx_escalations_conversation
  on public.escalations (conversation_id, created_at);

-- ---------------------------------------------------------------------------
-- Evaluations (Week 6 test-scenario evidence)
-- ---------------------------------------------------------------------------
create table if not exists public.evaluations (
  id                bigint generated always as identity primary key,
  scenario          text not null,
  expected_behavior text not null,
  actual_behavior   text not null,
  verdict           text not null check (verdict in ('pass', 'fail')),
  notes             text not null default '',
  created_at        timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Approved knowledge base chunks (retrieval source of truth)
-- Loaded from assets/relaypay-knowledge-base.md by the seed command.
-- ---------------------------------------------------------------------------
create table if not exists public.kb_chunks (
  id      text primary key,
  title   text not null,
  heading text not null default '',
  content text not null,
  summary text not null
);

-- ---------------------------------------------------------------------------
-- Row Level Security: the application uses the service role key
-- (bypasses RLS) from the server only. No anon/public policies exist,
-- so public keys expose nothing.
-- ---------------------------------------------------------------------------
alter table public.customers          enable row level security;
alter table public.transactions       enable row level security;
alter table public.payouts            enable row level security;
alter table public.conversations      enable row level security;
alter table public.conversation_turns enable row level security;
alter table public.retrieval_logs     enable row level security;
alter table public.tool_calls            enable row level security;
alter table public.conversation_events   enable row level security;
alter table public.support_tickets    enable row level security;
alter table public.escalations        enable row level security;
alter table public.evaluations        enable row level security;
alter table public.kb_chunks          enable row level security;
