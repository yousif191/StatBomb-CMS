-- Phase 2: durable SLA schedule generations and in-site event ledger.
-- This migration was applied to the isolated Testing project only.
-- Do not apply to Production until Phase 6 is explicitly approved.

create table public.assignment_sla_schedules (
  id uuid primary key default gen_random_uuid(),
  assignment_id uuid not null references public.assignments(id) on delete cascade,
  collector_id uuid not null references public.profiles(id),
  generation integer not null check (generation >= 1),
  sla_at timestamptz not null,
  warning_due_at timestamptz not null,
  reason text not null check (reason in ('distributed','sla_changed','collector_reassigned','restored')),
  state text not null default 'active' check (state in ('active','superseded','cancelled','completed')),
  cancel_reason text check (cancel_reason is null or cancel_reason in ('completed','distribution_removed','admin_hidden','sla_changed','collector_reassigned','replaced')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  cancelled_at timestamptz,
  completed_at timestamptz,
  constraint assignment_sla_schedules_warning_before_sla check (warning_due_at <= sla_at),
  constraint assignment_sla_schedules_generation_unique unique (assignment_id,generation)
);

create unique index assignment_sla_schedules_one_active_per_assignment_uidx
  on public.assignment_sla_schedules (assignment_id)
  where state='active';

create index assignment_sla_schedules_collector_idx
  on public.assignment_sla_schedules (collector_id);

create table public.assignment_sla_events (
  id uuid primary key default gen_random_uuid(),
  schedule_id uuid not null references public.assignment_sla_schedules(id) on delete cascade,
  assignment_id uuid not null references public.assignments(id) on delete cascade,
  collector_id uuid not null references public.profiles(id),
  generation integer not null check (generation >= 1),
  event_type text not null check (event_type in ('warning','overdue')),
  due_at timestamptz not null,
  precheck_at timestamptz not null,
  next_action_at timestamptz not null,
  state text not null default 'pending' check (state in ('pending','prechecked','claimed','sent','cancelled','skipped')),
  attempt_count integer not null default 0 check (attempt_count >= 0),
  claimed_at timestamptz,
  lease_expires_at timestamptz,
  prechecked_at timestamptz,
  sent_at timestamptz,
  cancelled_at timestamptz,
  cancel_reason text,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint assignment_sla_events_generation_idempotency
    unique (assignment_id,collector_id,generation,event_type),
  constraint assignment_sla_events_lease_pair
    check ((claimed_at is null and lease_expires_at is null) or (claimed_at is not null and lease_expires_at is not null))
);

create index assignment_sla_events_due_idx
  on public.assignment_sla_events (next_action_at,id)
  where state in ('pending','prechecked','claimed');

create index assignment_sla_events_assignment_idx
  on public.assignment_sla_events (assignment_id,generation);

create index assignment_sla_events_schedule_idx
  on public.assignment_sla_events (schedule_id);

alter table public.notifications
  add column sla_event_id uuid
  references public.assignment_sla_events(id) on delete set null;

create unique index notifications_sla_event_uidx
  on public.notifications (sla_event_id)
  where sla_event_id is not null;

-- Existing notification rows are preserved. Generation-based event identity
-- replaces the old per-assignment/per-recipient warning uniqueness key.
drop index if exists public.notifications_sla_warning_assignment_recipient_uidx;

alter table public.assignment_sla_schedules enable row level security;
alter table public.assignment_sla_events enable row level security;

revoke all on table public.assignment_sla_schedules from anon,authenticated;
revoke all on table public.assignment_sla_events from anon,authenticated;

grant select,insert,update,delete on table public.assignment_sla_schedules to service_role;
grant select,insert,update,delete on table public.assignment_sla_events to service_role;

comment on table public.assignment_sla_schedules is
  'Internal immutable-by-generation SLA schedule snapshots. One active generation per assignment.';
comment on table public.assignment_sla_events is
  'Internal durable Warning/Overdue event queue and idempotency ledger. Process due rows only.';
comment on column public.notifications.sla_event_id is
  'Optional link to the durable SLA event that created this in-site notification.';
