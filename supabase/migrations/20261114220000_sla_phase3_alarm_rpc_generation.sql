-- Phase 3C: expose only current-generation SLA alarm events to the existing in-site alarm UI.
-- This RPC reads the durable event ledger; it does not use the general notifications table.

drop function if exists public.get_sla_alert_assignments(text);

create function public.get_sla_alert_assignments(p_scope text default 'collector')
returns table (
  assignment_id uuid,
  sla timestamptz,
  status assignment_status,
  home_team text,
  away_team text,
  competition text,
  collector_name text,
  half text,
  task text,
  generation integer
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    a.id as assignment_id,
    a.sla,
    a.status,
    m.home_team,
    m.away_team,
    m.competition,
    coalesce(c.full_name, c.email, 'Unknown collector') as collector_name,
    a.half,
    a.task,
    s.generation
  from public.assignments a
  join public.matches m on m.id = a.match_id
  join public.assignment_sla_schedules s
    on s.assignment_id = a.id
   and s.state = 'active'
   and s.collector_id = a.collector_id
   and s.sla_at = a.sla
  join public.assignment_sla_events e
    on e.schedule_id = s.id
   and e.assignment_id = a.id
   and e.generation = s.generation
   and e.event_type = 'warning'
   and e.state = 'sent'
  left join public.profiles c on c.id = a.collector_id
  where a.status in ('Not Started'::public.assignment_status, 'In Progress'::public.assignment_status)
    and a.sla > now()
    and (
      (
        p_scope = 'admin'
        and exists (
          select 1 from public.profiles me
          where me.id = auth.uid() and me.role = 'admin'
        )
        and a.hidden_from_admin_dashboard = false
        and a.distribution_present = true
      )
      or
      (
        p_scope = 'collector'
        and a.collector_id = auth.uid()
        and exists (
          select 1 from public.profiles me
          where me.id = auth.uid() and me.role = 'collector'
            and me.deleted_at is null and me.suspended_at is null
        )
        and (
          a.distribution_present = true
          or a.status = 'In Progress'::public.assignment_status
        )
      )
    )
  order by a.sla asc;
$$;

revoke all on function public.get_sla_alert_assignments(text) from public, anon;
grant execute on function public.get_sla_alert_assignments(text) to authenticated;

comment on function public.get_sla_alert_assignments(text) is
  'Returns only sent Warning events from the active SLA schedule generation for the signed-in Admin or Collector alarm UI.';