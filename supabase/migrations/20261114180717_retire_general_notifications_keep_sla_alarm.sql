-- General in-app notifications are retired.
-- The SLA alarm remains a live assignment-based UI feature (GlobalSlaAlerts),
-- and the scanner still records warning/overdue state on assignments. It no
-- longer writes notification rows. Historical notification rows are retained.

create or replace function reassign_assignment(
  p_assignment_id uuid, p_new_collector_id uuid, p_mode text
) returns assignments
language plpgsql
security definer
set search_path = public
as $$
declare
  v_assignment assignments%rowtype;
  v_old_collector_id uuid;
  v_admin_id uuid := auth.uid();
begin
  if p_mode not in ('preserve', 'reset') then
    raise exception 'invalid reassignment mode';
  end if;
  if not exists (
    select 1 from profiles where id = v_admin_id and role = 'admin'
  ) then
    raise exception 'only admins can reassign assignments';
  end if;
  if not is_assignable_collector_target(p_new_collector_id) then
    raise exception 'new collector does not exist or is not active';
  end if;

  select * into v_assignment from assignments
  where id = p_assignment_id
  for update;
  if not found then raise exception 'assignment not found'; end if;
  if v_assignment.collector_id = p_new_collector_id then
    raise exception 'cannot reassign to the same collector';
  end if;
  v_old_collector_id := v_assignment.collector_id;

  update assignments
  set previous_collector_id = collector_id,
      collector_id = p_new_collector_id,
      status = case when p_mode = 'reset' then 'Not Started' else status end,
      started_at = case when p_mode = 'reset' then null else started_at end,
      completed_at = case when p_mode = 'reset' then null else completed_at end,
      updated_at = now()
  where id = p_assignment_id
  returning * into v_assignment;

  insert into activity_logs (user_id, assignment_id, action, old_value, new_value)
  values (
    v_admin_id, p_assignment_id, 'assignment_reassigned',
    jsonb_build_object('collector_id', v_old_collector_id),
    jsonb_build_object('collector_id', p_new_collector_id, 'mode', p_mode)
  );

  return v_assignment;
end;
$$;

create or replace function evaluate_assignment_sla_states()
returns table (warnings_fired bigint, overdue_fired bigint)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_warnings bigint := 0;
  v_overdue bigint := 0;
begin
  update assignments
  set sla_warning_sent_at = now(),
      updated_at = now()
  where status <> 'Completed'
    and sla_warning_sent_at is null
    and now() >= sla - interval '1 hour';
  get diagnostics v_warnings = row_count;

  update assignments
  set status = 'Overdue',
      overdue_notified_at = now(),
      updated_at = now()
  where status not in ('Completed', 'Overdue')
    and overdue_notified_at is null
    and now() > sla;
  get diagnostics v_overdue = row_count;

  return query select v_warnings, v_overdue;
end;
$$;

revoke all on function evaluate_assignment_sla_states() from public;
revoke all on function evaluate_assignment_sla_states() from anon;
revoke all on function evaluate_assignment_sla_states() from authenticated;
grant execute on function evaluate_assignment_sla_states() to service_role;
