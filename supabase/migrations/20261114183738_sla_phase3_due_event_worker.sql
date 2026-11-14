-- Phase 3B: bounded, due-only SLA event processor.
-- It processes durable events in a single transaction, locking assignment first
-- and event second to match assignment-trigger lock order and avoid deadlocks.
-- No rows are written to the retired general notifications table.

create or replace function public.process_assignment_sla_events(p_batch_size integer default 100)
returns table (
  processed bigint,
  warnings_sent bigint,
  overdue_marked bigint,
  cancelled bigint,
  skipped bigint,
  prechecked bigint
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_candidate record;
  v_event public.assignment_sla_events%rowtype;
  v_assignment public.assignments%rowtype;
  v_schedule public.assignment_sla_schedules%rowtype;
  v_processed bigint := 0;
  v_warnings bigint := 0;
  v_overdue bigint := 0;
  v_cancelled bigint := 0;
  v_skipped bigint := 0;
  v_prechecked bigint := 0;
  v_limit integer := greatest(1, least(coalesce(p_batch_size, 100), 500));
begin
  for v_candidate in
    select e.id, e.assignment_id
    from public.assignment_sla_events e
    where e.state in ('pending','prechecked')
      and e.next_action_at <= now()
    order by e.next_action_at, e.id
    limit v_limit
  loop
    -- Lock parent assignment first. Assignment mutation triggers use the same
    -- lock order before updating schedules/events.
    select * into v_assignment
    from public.assignments a
    where a.id = v_candidate.assignment_id
    for update skip locked;

    if not found then
      continue;
    end if;

    select * into v_event
    from public.assignment_sla_events e
    where e.id = v_candidate.id
      and e.state in ('pending','prechecked')
      and e.next_action_at <= now()
    for update skip locked;

    if not found then
      continue;
    end if;

    v_processed := v_processed + 1;

    select * into v_schedule
    from public.assignment_sla_schedules s
    where s.id = v_event.schedule_id
    for update;

    if not found
       or v_schedule.state <> 'active'
       or v_schedule.generation <> v_event.generation
       or v_schedule.assignment_id <> v_assignment.id then
      update public.assignment_sla_events
      set state='cancelled', cancel_reason='stale_generation',
          cancelled_at=now(), attempt_count=attempt_count+1, updated_at=now()
      where id=v_event.id;
      v_cancelled := v_cancelled + 1;
      continue;
    end if;

    if v_assignment.status = 'Completed' then
      update public.assignment_sla_schedules
      set state='completed', completed_at=coalesce(completed_at,now()), updated_at=now()
      where id=v_schedule.id;

      update public.assignment_sla_events
      set state='cancelled', cancel_reason='completed',
          cancelled_at=now(), attempt_count=attempt_count+1, updated_at=now()
      where schedule_id=v_schedule.id
        and state in ('pending','prechecked','claimed');
      v_cancelled := v_cancelled + 1;
      continue;
    end if;

    if not v_assignment.distribution_present or v_assignment.hidden_from_admin_dashboard then
      update public.assignment_sla_schedules
      set state='cancelled',
          cancel_reason=case when not v_assignment.distribution_present then 'distribution_removed' else 'admin_hidden' end,
          cancelled_at=coalesce(cancelled_at,now()), updated_at=now()
      where id=v_schedule.id;

      update public.assignment_sla_events
      set state='cancelled',
          cancel_reason=case when not v_assignment.distribution_present then 'distribution_removed' else 'admin_hidden' end,
          cancelled_at=now(), attempt_count=attempt_count+1, updated_at=now()
      where schedule_id=v_schedule.id
        and state in ('pending','prechecked','claimed');
      v_cancelled := v_cancelled + 1;
      continue;
    end if;

    if v_assignment.collector_id <> v_schedule.collector_id
       or v_assignment.sla <> v_schedule.sla_at then
      update public.assignment_sla_events
      set state='cancelled', cancel_reason='assignment_snapshot_changed',
          cancelled_at=now(), attempt_count=attempt_count+1, updated_at=now()
      where id=v_event.id;
      v_cancelled := v_cancelled + 1;
      continue;
    end if;

    -- Warning precheck is one minute before due. A late worker still performs
    -- the final state check below without delaying an already-due warning.
    if v_event.event_type = 'warning'
       and v_event.state = 'pending'
       and now() < v_event.due_at then
      if v_assignment.status not in ('Not Started','In Progress') then
        update public.assignment_sla_events
        set state='cancelled', cancel_reason='ineligible_status',
            cancelled_at=now(), attempt_count=attempt_count+1, updated_at=now()
        where id=v_event.id;
        v_cancelled := v_cancelled + 1;
      else
        update public.assignment_sla_events
        set state='prechecked', prechecked_at=now(),
            next_action_at=due_at, attempt_count=attempt_count+1, updated_at=now()
        where id=v_event.id;
        v_prechecked := v_prechecked + 1;
      end if;
      continue;
    end if;

    if v_event.event_type = 'warning' then
      -- Never deliver a stale Warning at/after SLA. The Overdue event is the
      -- only event allowed to act once the deadline has elapsed.
      if now() >= v_assignment.sla then
        update public.assignment_sla_events
        set state='skipped', cancel_reason='sla_elapsed',
            attempt_count=attempt_count+1, updated_at=now()
        where id=v_event.id;
        v_skipped := v_skipped + 1;
      elsif v_assignment.status in ('Not Started','In Progress') then
        -- "sent" is the durable in-site alarm event. The UI reads active
        -- assignment/event state; no general notification row is created.
        update public.assignment_sla_events
        set state='sent', sent_at=now(),
            attempt_count=attempt_count+1, updated_at=now()
        where id=v_event.id;
        v_warnings := v_warnings + 1;
      else
        update public.assignment_sla_events
        set state='cancelled', cancel_reason='ineligible_status',
            cancelled_at=now(), attempt_count=attempt_count+1, updated_at=now()
        where id=v_event.id;
        v_cancelled := v_cancelled + 1;
      end if;
    elsif v_event.event_type = 'overdue' then
      if now() < v_assignment.sla then
        update public.assignment_sla_events
        set state='pending', next_action_at=v_assignment.sla,
            attempt_count=attempt_count+1, updated_at=now()
        where id=v_event.id;
        v_skipped := v_skipped + 1;
      elsif v_assignment.status in ('Not Started','In Progress') then
        update public.assignments
        set status='Overdue',
            overdue_notified_at=coalesce(overdue_notified_at,now()),
            updated_at=now()
        where id=v_assignment.id;

        update public.assignment_sla_events
        set state='sent', sent_at=now(),
            attempt_count=attempt_count+1, updated_at=now()
        where id=v_event.id;
        v_overdue := v_overdue + 1;
      elsif v_assignment.status = 'Overdue' then
        update public.assignment_sla_events
        set state='sent', sent_at=coalesce(sent_at,now()),
            attempt_count=attempt_count+1, updated_at=now()
        where id=v_event.id;
        v_overdue := v_overdue + 1;
      else
        update public.assignment_sla_events
        set state='cancelled', cancel_reason='ineligible_status',
            cancelled_at=now(), attempt_count=attempt_count+1, updated_at=now()
        where id=v_event.id;
        v_cancelled := v_cancelled + 1;
      end if;
    else
      update public.assignment_sla_events
      set state='skipped', cancel_reason='unknown_event_type',
          attempt_count=attempt_count+1, updated_at=now()
      where id=v_event.id;
      v_skipped := v_skipped + 1;
    end if;
  end loop;

  return query select v_processed, v_warnings, v_overdue, v_cancelled, v_skipped, v_prechecked;
end;
$$;

revoke all on function public.process_assignment_sla_events(integer) from public, anon, authenticated;
grant execute on function public.process_assignment_sla_events(integer) to service_role;

comment on function public.process_assignment_sla_events(integer) is
  'Processes only due durable SLA events in bounded batches. Uses assignment-first row locking, latest-state checks, and writes no general notification rows.';
