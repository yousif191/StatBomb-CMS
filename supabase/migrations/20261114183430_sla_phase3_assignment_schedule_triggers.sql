-- Phase 3A: make assignment mutations create/cancel durable SLA schedule generations.
-- Testing only. The legacy scanner remains the active processor until Phase 4 cutover.

create or replace function public.prepare_assignment_sla_schedule()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'UPDATE' then
    if new.sla is distinct from old.sla
       or new.collector_id is distinct from old.collector_id
       or (old.distribution_present = false and new.distribution_present = true)
       or (old.hidden_from_admin_dashboard = true and new.hidden_from_admin_dashboard = false) then
      new.sla_warning_sent_at := null;
      new.overdue_notified_at := null;
    end if;

    if old.status = 'Overdue'
       and new.sla is distinct from old.sla
       and new.sla > now() then
      new.status := case
        when new.started_at is not null then 'In Progress'::assignment_status
        else 'Not Started'::assignment_status
      end;
      new.overdue_notified_at := null;
    end if;
  end if;
  return new;
end;
$$;

revoke all on function public.prepare_assignment_sla_schedule() from public, anon, authenticated;

create or replace function public.sync_assignment_sla_schedule()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_reason text;
  v_generation integer;
  v_schedule_id uuid;
  v_warning_due timestamptz;
  v_warning_precheck timestamptz;
begin
  if new.status = 'Completed' then
    update public.assignment_sla_schedules
       set state = 'completed',
           completed_at = coalesce(completed_at, now()),
           updated_at = now()
     where assignment_id = new.id
       and state = 'active';

    update public.assignment_sla_events
       set state = 'cancelled',
           cancel_reason = 'completed',
           cancelled_at = now(),
           updated_at = now()
     where assignment_id = new.id
       and state in ('pending','prechecked','claimed');
    return new;
  end if;

  if not new.distribution_present or new.hidden_from_admin_dashboard then
    update public.assignment_sla_schedules
       set state = 'cancelled',
           cancel_reason = case
             when not new.distribution_present then 'distribution_removed'
             else 'admin_hidden'
           end,
           cancelled_at = coalesce(cancelled_at, now()),
           updated_at = now()
     where assignment_id = new.id
       and state = 'active';

    update public.assignment_sla_events
       set state = 'cancelled',
           cancel_reason = case
             when not new.distribution_present then 'distribution_removed'
             else 'admin_hidden'
           end,
           cancelled_at = now(),
           updated_at = now()
     where assignment_id = new.id
       and state in ('pending','prechecked','claimed');
    return new;
  end if;

  if tg_op = 'INSERT' then
    v_reason := 'distributed';
  elsif old.collector_id is distinct from new.collector_id then
    v_reason := 'collector_reassigned';
  elsif old.sla is distinct from new.sla then
    v_reason := 'sla_changed';
  elsif old.distribution_present = false and new.distribution_present = true then
    v_reason := 'restored';
  elsif old.hidden_from_admin_dashboard = true and new.hidden_from_admin_dashboard = false then
    v_reason := 'restored';
  elsif old.status = 'Completed' and new.status <> 'Completed' then
    v_reason := 'restored';
  else
    return new;
  end if;

  update public.assignment_sla_events
     set state = 'cancelled',
         cancel_reason = 'replaced',
         cancelled_at = now(),
         updated_at = now()
   where assignment_id = new.id
     and state in ('pending','prechecked','claimed');

  update public.assignment_sla_schedules
     set state = 'superseded',
         cancel_reason = 'replaced',
         cancelled_at = now(),
         updated_at = now()
   where assignment_id = new.id
     and state = 'active';

  select coalesce(max(generation), 0) + 1
    into v_generation
    from public.assignment_sla_schedules
   where assignment_id = new.id;

  insert into public.assignment_sla_schedules (
    assignment_id, collector_id, generation, sla_at, warning_due_at, reason, state
  ) values (
    new.id,
    new.collector_id,
    v_generation,
    new.sla,
    case
      when v_reason = 'collector_reassigned'
       and new.sla > now()
       and new.sla <= now() + interval '1 hour'
        then now()
      else new.sla - interval '1 hour'
    end,
    v_reason,
    'active'
  ) returning id, warning_due_at into v_schedule_id, v_warning_due;

  v_warning_precheck := case
    when v_warning_due <= now() then now()
    else greatest(v_warning_due - interval '1 minute', now())
  end;

  insert into public.assignment_sla_events (
    schedule_id, assignment_id, collector_id, generation, event_type,
    due_at, precheck_at, next_action_at, state
  ) values (
    v_schedule_id, new.id, new.collector_id, v_generation, 'warning',
    v_warning_due, v_warning_precheck,
    greatest(v_warning_precheck, now()), 'pending'
  ), (
    v_schedule_id, new.id, new.collector_id, v_generation, 'overdue',
    new.sla, new.sla, greatest(new.sla, now()), 'pending'
  );

  return new;
end;
$$;

revoke all on function public.sync_assignment_sla_schedule() from public, anon, authenticated;

drop trigger if exists assignments_prepare_sla_schedule on public.assignments;
create trigger assignments_prepare_sla_schedule
before update of collector_id, sla, status, distribution_present, hidden_from_admin_dashboard
on public.assignments
for each row execute function public.prepare_assignment_sla_schedule();

drop trigger if exists assignments_sync_sla_schedule on public.assignments;
create trigger assignments_sync_sla_schedule
after insert or update of collector_id, sla, status, distribution_present, hidden_from_admin_dashboard
on public.assignments
for each row execute function public.sync_assignment_sla_schedule();

-- Backfill current active Testing assignments so the new worker can be tested
-- against the existing Testing dataset. No assignment rows are modified.
with active_assignments as (
  select a.*
  from public.assignments a
  where a.status <> 'Completed'
    and a.distribution_present = true
    and a.hidden_from_admin_dashboard = false
    and not exists (
      select 1 from public.assignment_sla_schedules s
      where s.assignment_id = a.id and s.state = 'active'
    )
), inserted_schedules as (
  insert into public.assignment_sla_schedules (
    assignment_id, collector_id, generation, sla_at, warning_due_at, reason, state
  )
  select
    a.id, a.collector_id,
    coalesce((select max(s.generation) from public.assignment_sla_schedules s where s.assignment_id = a.id),0)+1,
    a.sla, a.sla - interval '1 hour', 'distributed', 'active'
  from active_assignments a
  returning id, assignment_id, collector_id, generation, sla_at, warning_due_at
)
insert into public.assignment_sla_events (
  schedule_id, assignment_id, collector_id, generation, event_type,
  due_at, precheck_at, next_action_at, state
)
select
  s.id, s.assignment_id, s.collector_id, s.generation, e.event_type,
  e.due_at, e.precheck_at, greatest(e.precheck_at, now()), 'pending'
from inserted_schedules s
cross join lateral (
  values
    ('warning'::text, s.warning_due_at, case when s.warning_due_at <= now() then now() else greatest(s.warning_due_at - interval '1 minute', now()) end),
    ('overdue'::text, s.sla_at, s.sla_at)
) as e(event_type, due_at, precheck_at);

comment on function public.sync_assignment_sla_schedule() is
  'Creates a new durable SLA generation on distribution, SLA change, reassignment, or restoration; cancels pending events on completion/removal/hide.';
