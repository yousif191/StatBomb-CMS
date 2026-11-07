-- Keep historical assignments in the database, but do not expose collectors
-- whose assignments are no longer part of the current visible distribution.
create or replace function public.get_match_collaborators_contact(p_match_id uuid)
returns table (
  assignment_id uuid,
  collector_id uuid,
  full_name text,
  task text,
  half text,
  status public.assignment_status,
  hr_code text,
  phone text
)
language sql
security definer
set search_path = public
stable
as $$
  select
    a.id,
    a.collector_id,
    p.full_name,
    a.task,
    a.half,
    a.status,
    p.hr_code,
    p.phone
  from public.assignments a
  join public.profiles p on p.id = a.collector_id
  where a.match_id = p_match_id
    and a.distribution_present = true
    and a.hidden_from_admin_dashboard = false
    and auth.uid() is not null
    and (public.is_admin() or public.is_active_collector(auth.uid()))
    and (
      public.is_admin()
      or exists (
        select 1
        from public.assignments mine
        where mine.match_id = p_match_id
          and mine.collector_id = auth.uid()
          and mine.distribution_present = true
          and mine.hidden_from_admin_dashboard = false
      )
    );
$$;

revoke all on function public.get_match_collaborators_contact(uuid) from public;
grant execute on function public.get_match_collaborators_contact(uuid) to authenticated;
