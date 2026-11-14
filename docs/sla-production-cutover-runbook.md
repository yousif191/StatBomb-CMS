# SLA Event Engine — Production Cutover Runbook

**Status:** Not executed. Production remains on the legacy SLA evaluator.

## Current architecture

- Testing Preview selects the durable event engine automatically through branch-scoped `TEST_SUPABASE_URL` and `NEXT_PUBLIC_TEST_SUPABASE_URL`.
- Production remains on the legacy evaluator unless `SLA_ENGINE_MODE=events` is explicitly set.
- Production remains on the legacy alarm read RPC unless `NEXT_PUBLIC_SLA_ENGINE_MODE=events` is explicitly set.
- The existing cron-job.org schedule remains the only scheduler. Do not add a second cron.
- General notification UI/writes are retired; the in-site SLA alarm remains. Historical notification rows are retained.

## Required pre-cutover checks

- [ ] Latest feature-branch Preview deployment is READY and uses the Testing Supabase project.
- [ ] Admin and Collector can sign in to Preview and the event-backed SLA alarm displays, loops audio, silences correctly, and refreshes after completion/reassignment.
- [ ] Create/distribute a fresh test assignment in Preview and verify a new schedule generation and exactly two events.
- [ ] Verify one-minute precheck, latest-state revalidation, overdue-only behavior after the SLA, completion cancellation, Distribution removal cancellation, Admin hide cancellation, SLA changes, and final-hour reassignment.
- [ ] Confirm the external cron still calls the existing `/api/cron/sla-scan` endpoint once per minute.
- [ ] Take/verify a Production database backup and record the current Vercel Production deployment before any cutover.
- [ ] Reconcile Production's migration history manually. Do not use a blind `supabase db push`: the repo has a pre-existing duplicate `0028` filename and Production has numeric baseline versions plus timestamped Match Master versions.

## Production schema preflight (read-only, verified 14 Nov 2026)

Production already has the required base columns:
- `assignments.sla`, `status`, `started_at`, `completed_at`
- `assignments.sla_warning_sent_at`, `overdue_notified_at`
- `assignments.distribution_present`, `hidden_from_admin_dashboard`
- `profiles.deleted_at`, `suspended_at`
- `matches.home_team`, `away_team`, `competition`

The schedule/event tables and the new worker do not yet exist in Production.

## Migration order

Apply only after all Testing phases pass. Preserve the SQL in the matching branch migration files and reconcile each resulting remote version after applying:

1. `20261114175135_sla_phase2_schedule_event_schema.sql`
2. `20261114180717_retire_general_notifications_keep_sla_alarm.sql`
3. `20261114183430_sla_phase3_assignment_schedule_triggers.sql`
4. `20261114183738_sla_phase3_due_event_worker.sql`
5. `20261114183818_sla_phase3_due_event_worker_duplicate_record.sql` (comment-only no-op, mirrors the duplicate idempotent Testing history entry)
6. `20261114183842_sla_phase3_alarm_rpc_generation.sql`
7. `20261114184806_sla_phase3_dual_engine_rollback_support.sql`

The last two RPC migrations temporarily replace and then restore the legacy RPC while adding the event-backed RPC. Apply them consecutively during the cutover window; do not deploy the new app between those two steps. The final state must expose both:
- `get_sla_alert_assignments` — legacy rollback path
- `get_sla_alarm_event_assignments` — durable event path

The migration set retains the notifications table and historical rows. It does not introduce push notifications or delete historical records.

## Cutover sequence

1. Confirm Production backup and current deployment SHA.
2. Apply the schema/function migrations in order and verify all objects, grants, and backfilled active assignments.
3. Verify the event worker function is executable only by `service_role`; verify alarm RPCs are callable by `authenticated` and not `anon`.
4. Verify active assignments have one active schedule generation and exactly one Warning plus one Overdue event.
5. Deploy the reviewed application code while both engine flags are still unset. It continues using the legacy evaluator and legacy alarm RPC.
6. Set Vercel Production `SLA_ENGINE_MODE=events` and `NEXT_PUBLIC_SLA_ENGINE_MODE=events`, then redeploy Production so server and browser switch together.
7. Keep the existing cron-job.org URL and cadence unchanged. Confirm route logs report `engine=event_queue`, then verify Warning and Overdue events are processed.
8. Monitor worker counts, assignment status changes, alarm reads, and runtime errors for the agreed observation window.

## Rollback

If the event engine misbehaves:

1. Unset `SLA_ENGINE_MODE` and `NEXT_PUBLIC_SLA_ENGINE_MODE` (or set both to `legacy`) and redeploy.
2. The cron endpoint returns to `evaluate_assignment_sla_states()`; the browser returns to `get_sla_alert_assignments()`.
3. Keep the schedule/event tables and rows. Do not drop them or delete notification history.
4. Re-enable event mode only after the cause is fixed and Testing passes again.

This rollback preserves the user's decision to keep the in-site SLA alarm while retiring ordinary notifications. It does not restore general notification creation.

## Explicit non-actions

- No Production migration has been applied as part of the current work.
- No Production Vercel environment variable has been changed.
- No cron-job.org schedule or URL has been changed.
- No Production deployment, merge, or domain promotion has been performed.
