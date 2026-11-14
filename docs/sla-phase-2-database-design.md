# SLA Rebuild — Phase 2 Database Design

**Project:** StatBomb-CMS  
**Branch:** `feat/sla-scheduling-rebuild`  
**Environment for implementation:** Supabase Testing (`cobunhmzrzyymjndmfvt`) only  
**Production schema/data:** read-only; no Production migration or write is authorized.

## Phase 2 goal

Persist durable SLA schedule generations and Warning/Overdue events. Future processing must select only due event rows, not scan the full `assignments` table on every scheduler tick.

## Approved behavior carried forward

- Create a schedule when an assignment is distributed.
- Replace the current schedule generation when its SLA or assigned Collector changes. Keep old generations as history and mark them superseded.
- Cancel pending events when the assignment is Completed, removed from the Distribution sheet (`distribution_present = false`), or hidden from the Admin dashboard.
- Warning is due one hour before SLA.
- Pre-alert status check runs one minute before Warning due time; Completed cancels, Not Started/In Progress continues.
- At actual send time, read the latest assignment state again. Completed cancels; Not Started/In Progress sends. The latest state at send time wins.
- At or after SLA, create Overdue only; never send stale Warning and Overdue together for the same generation. If the worker resumes after both times, skip Warning and process Overdue only.
- Reassignment to a new Collector within the final hour before SLA creates an immediate Warning for the new Collector.
- If an Overdue assignment's SLA moves into the future, restore status to In Progress when `started_at` exists, otherwise Not Started.
- Preserve current in-site notification cards, looping `/sounds/sla-warning.wav`, explicit sound enable, Stop Alarm, local silencing, and cross-tab single-tab audio ownership.
- In-site alerts only. No Web Push, VAPID, service-worker push, or delivery promise while the website is closed.
- Reuse the existing cron-job.org scanner during implementation; do not add a second scheduler.

## Read-only schema audit (Testing, 14 Nov 2026)

### Existing `public.assignments` fields relevant to SLA

- `id uuid`, `match_id uuid`, `collector_id uuid`
- `sla timestamptz NOT NULL`, `shift_date date`
- `status assignment_status NOT NULL` (Not Started / In Progress / Completed / Overdue)
- `started_at`, `completed_at`
- `sla_warning_sent_at`, `overdue_notified_at`
- `distribution_present boolean NOT NULL DEFAULT true`
- `hidden_from_admin_dashboard boolean NOT NULL DEFAULT false`

Existing logical identity is unique on `(match_id, task, half)`. Existing SLA index is `assignments_sla_idx` on `sla` where status is not Completed.

### Existing `public.notifications`

- Existing durable in-site notification table with `recipient_id`, `assignment_id`, `type`, `title`, `message`, `sent_at`, `read_at`.
- Legacy push columns `pushed_at` and `push_claimed_at` exist. They are not part of this in-site-only rebuild.
- Existing unique partial index `notifications_sla_warning_assignment_recipient_uidx` on `(assignment_id, recipient_id)` for `sla_warning` does not support a second warning for a later schedule generation. Phase 2 schema migration must replace this old idempotency shape with generation/event-based idempotency without deleting notification history.

### Existing functions / scheduler

- `evaluate_assignment_sla_states()` currently scans assignments and writes Warning/Overdue notifications. The current implementation has no upper bound on Warning, does not exclude hidden/removed assignments, and does not restore Overdue when SLA moves into the future.
- `get_sla_alert_assignments()` is a read RPC for the current UI.
- `claim_pending_push_notifications()` is legacy push delivery and will not be used for the new SLA flow.
- Production currently has one external cron-job.org scanner every minute in Africa/Cairo. Testing has no `cron.job` relation / pg_cron job. Do not install or schedule another scanner in Phase 2.

### Migration history / drift

Production and Testing migration histories use different version identifiers. Examples:
- `get_sla_alert_assignments_rpc`: repo timestamp `20261029202900`, Production applied as `20261029175551`.
- `allow_start_unstarted_overdue_assignments`: repo timestamp `20261026193000`, Production applied as `20261026161259`.
- `add_match_master_sync_lock`: repo timestamp `20261030150000`, Production applied as `20261030134217`.
- Production has `20261030134954 create_match_master_sheet_delta`.
- Repo has duplicate `0028` migration filenames. Do not replay old migrations or assume repo filenames match remote migration history.

## Proposed schema

### 1. `public.assignment_sla_schedules`

One row per assignment generation. This is the immutable snapshot of the assignment's SLA routing at the time the generation was created.

| Column | Type | Purpose |
|---|---|---|
| `id` | uuid PK | Schedule generation ID |
| `assignment_id` | uuid FK → assignments.id | Source assignment |
| `collector_id` | uuid FK → profiles.id | Collector for this generation |
| `generation` | integer | Monotonically increasing generation per assignment |
| `sla_at` | timestamptz | Exact SLA snapshot from assignments |
| `warning_due_at` | timestamptz | Normal SLA minus one hour; may be now for immediate reassignment warning |
| `reason` | text | distributed / sla_changed / collector_reassigned / restored |
| `state` | text | active / superseded / cancelled / completed |
| `cancel_reason` | text nullable | completed / distribution_removed / admin_hidden / sla_changed / collector_reassigned / replaced |
| `created_at`, `updated_at` | timestamptz | Audit timestamps |
| `cancelled_at`, `completed_at` | timestamptz nullable | Lifecycle timestamps |

Constraints:
- Unique `(assignment_id, generation)`.
- At most one active schedule per assignment via partial unique index.
- `generation >= 1`.
- State and reason values constrained to explicit allow-lists.
- FK deletion behavior must preserve history where possible; assignment deletion is already cascading in the current schema, so the schedule follows assignment lifecycle.

### 2. `public.assignment_sla_events`

Two event types per generation: Warning and Overdue. This is the durable processing queue and idempotency ledger.

| Column | Type | Purpose |
|---|---|---|
| `id` | uuid PK | Event ID |
| `schedule_id` | uuid FK → assignment_sla_schedules.id | Owning generation |
| `assignment_id` | uuid FK → assignments.id | Indexed lookup / integrity |
| `collector_id` | uuid FK → profiles.id | Intended recipient snapshot |
| `generation` | integer | Generation snapshot |
| `event_type` | text | warning / overdue |
| `due_at` | timestamptz | Actual event time |
| `precheck_at` | timestamptz | Warning: one minute before due; Overdue: due time |
| `next_action_at` | timestamptz | Next due action; indexed queue key |
| `state` | text | pending / prechecked / claimed / sent / cancelled / skipped |
| `attempt_count` | integer | Retry counter |
| `claimed_at`, `lease_expires_at` | timestamptz nullable | Atomic worker claim / recovery |
| `prechecked_at`, `sent_at`, `cancelled_at` | timestamptz nullable | Lifecycle timestamps |
| `cancel_reason`, `last_error` | text nullable | Diagnostics |
| `created_at`, `updated_at` | timestamptz | Audit timestamps |

Constraints and indexes:
- Unique `(assignment_id, collector_id, generation, event_type)` — one event of each type per Collector and generation.
- Check constraints for event type, state, and non-negative attempt count.
- Partial B-tree index on `next_action_at` for rows in pending/prechecked states; scheduler reads only due rows.
- Index on `assignment_id` and `schedule_id`.
- Lease expiry supports safe reclaim after worker failure.

### 3. Link existing in-site notifications to the event

Add nullable `notifications.sla_event_id` FK to `assignment_sla_events.id`, plus a unique partial index on non-null `sla_event_id`. This gives a strict one-event-to-one-notification link and supports durable reconnect without relying on push columns.

Replace the legacy warning uniqueness index `(assignment_id, recipient_id)` with event-based uniqueness only in the Testing migration. Do not delete or rewrite existing notification rows. This is necessary because a later generation can legitimately warn the same Collector again.

## Processing and transaction design

1. Schedule creation/replacement and cancellation must happen in the same database transaction as the assignment mutation. Phase 3 will cover all assignment mutation paths, preferably through one database trigger/helper rather than scattered client-side writes.
2. Replacing a schedule locks the assignment row, supersedes the previous active generation, cancels its pending events, increments generation, inserts the new schedule and its Warning/Overdue events.
3. Worker claims due events in bounded batches using row locks with `FOR UPDATE SKIP LOCKED` and a short lease. No full Assignments scan.
4. Before Warning due, worker reads the latest assignment row and verifies: not Completed, distribution present, not hidden, schedule generation still active, and current Collector/SLA still match the snapshot.
5. At actual send time, worker reads the assignment again immediately before inserting the in-site notification. This is the authoritative check.
6. Notification insert and event state transition to sent must be atomic. Unique `sla_event_id` prevents duplicate notification rows on retries.
7. If the event is overdue and current SLA has moved into the future, the schedule is replaced and assignment status is restored from started_at.
8. If a worker crashes after claiming, lease expiry makes the event reclaimable. Retries must be idempotent.

## Security model

- Both new tables have RLS enabled.
- No direct `anon` or `authenticated` table grants or client policies; these are server-internal queue/history tables.
- Grant only the minimum required table privileges to `service_role`.
- Server worker uses the Testing service-role key only in server-side code.
- Any SECURITY DEFINER helper must have a fixed safe search_path, explicit role checks, and narrowly scoped EXECUTE grants. No blanket revokes or blanket grants.
- Existing notifications RLS remains the user-facing boundary: Collector reads own notifications; Admin retains current approved visibility.

## Migration plan

1. Add the two internal tables, constraints, and indexes on Testing only.
2. Add `notifications.sla_event_id` and event-based uniqueness; preserve all existing notification rows.
3. Verify RLS, grants, FK behavior, due-query index, and idempotency with synthetic Testing-only records.
4. Keep the legacy evaluator and external cron unchanged until Phase 3/4 cutover is ready. Do not run both old and new notification processors against the same assignments.
5. Generate the repository migration using the Supabase CLI workflow, reconcile its version with Testing's remote migration history, and commit only on `feat/sla-scheduling-rebuild`.
6. Never apply this migration to Production during implementation.

## Open implementation detail for Phase 3

Immediate reassignment warning within the final hour has no one-minute precheck interval. The worker must perform the eligibility check and final latest-state check back-to-back before creating the notification, without delaying the immediate warning by a minute.

## Phase 2 exit criteria

- Design reviewed against live schema and approved behavior.
- Migration is prepared and applied only to Testing.
- RLS, grants, constraints, indexes, and idempotency verified.
- No Production schema/data/cron/environment changes.
- No new scheduler installed.


## Phase 2 execution status — 14 Nov 2026

- [x] Read-only schema/RPC/RLS/grant/index/migration audit completed on Testing and Production.
- [x] Design and SQL draft committed on the feature branch.
- [x] Migration `20261114175135_sla_phase2_schedule_event_schema` applied to Supabase Testing only.
- [x] Both new tables exist and RLS is enabled.
- [x] `anon` and `authenticated` have no table privileges on the internal SLA tables; `service_role` has the required CRUD privileges.
- [x] Due-work partial index, assignment/schedule lookup indexes, generation uniqueness, and one-active-schedule uniqueness verified.
- [x] Legacy per-assignment warning unique index replaced by notification-to-event uniqueness. Existing Testing notifications were zero; no notification history was deleted.
- [x] Transactional synthetic test verified duplicate event generation and duplicate notification event links are rejected; transaction was rolled back.
- [x] Rollback verification confirmed no synthetic match, assignment, schedule, event, or notification rows remained.
- [x] Production migration history was inspected read-only; no Production migration was applied.

Advisor note: Supabase reports `rls_enabled_no_policy` INFO for the two new tables. This is intentional: the tables are server-internal, RLS is enabled, and `anon`/`authenticated` have no table grants. The due index may appear unused until Phase 3 introduces the due-only worker. Existing unrelated advisor findings were not changed.

**Phase 2 status: DATABASE STRUCTURE APPLIED AND BASIC SECURITY/IDEMPOTENCY VERIFIED ON TESTING.**  
**Still pending before Phase 2 sign-off:** review the final migration diff against repository history and run the project’s local migration/type checks when the repository CLI workspace is available. No scheduling trigger, worker, or notification sender has been enabled; those belong to Phase 3/4.


## Phase 3A execution status — 14 Nov 2026

- [x] Added `prepare_assignment_sla_schedule()` before-update trigger to reset legacy markers on SLA/Collector changes and restore an Overdue assignment when its SLA is moved into the future.
- [x] Added `sync_assignment_sla_schedule()` after-insert/update trigger to create durable generations for distribution, SLA changes, reassignment, and restoration.
- [x] Pending Warning/Overdue events are cancelled when an assignment is completed, removed from Distribution, or hidden from the Admin dashboard.
- [x] Reassignment within the final hour schedules the new Collector's Warning immediately.
- [x] Added a Testing-only backfill for eligible active assignments. Testing currently contains only Completed assignments, so the backfill correctly created zero schedules and did not modify assignments.
- [x] Applied migration `20261114210000_sla_phase3_assignment_schedule_triggers` to Testing only.
- [x] Transactional synthetic test verified generation creation on restore, a new generation on SLA change, a new generation on Collector reassignment, immediate final-hour Warning scheduling, and cancellation on completion. The transaction was rolled back.
- [x] Post-test verification confirmed zero synthetic schedule/event rows remained and all 12 eligible Completed assignments were unchanged.
- [ ] Still pending: test distribution removal and Admin hide cancellation; test SLA extension from Overdue; implement and verify the due-only event worker (Phase 3B/4).
- [ ] Legacy evaluator remains active; no worker cutover has occurred.

**Phase 3A status: assignment-to-schedule lifecycle trigger implemented and transactionally smoke-tested on Testing.**


## Phase 3B/3C execution status — 14 Nov 2026

- [x] Added `process_assignment_sla_events(batch_size)` as a bounded due-only processor. It locks the assignment before its event row, matching the trigger lock order; it uses `SKIP LOCKED` to allow concurrent workers without duplicate processing.
- [x] Added the one-minute Warning precheck and final latest-assignment validation at send time.
- [x] A late worker skips Warning when the SLA has elapsed and processes Overdue only.
- [x] Overdue processing updates assignment status; if an Overdue assignment's SLA is moved into the future, the assignment trigger restores Not Started/In Progress and creates a new generation.
- [x] Worker writes no rows to `notifications`; the event ledger is the durable SLA record.
- [x] Updated `get_sla_alert_assignments` to return only Warning events marked sent for the active generation, with explicit Admin/Collector scope checks.
- [x] Added generation to the alarm query response and browser silencing key so a new generation cannot inherit an old silenced alarm.
- [x] Applied worker and alarm RPC migrations to Testing only.
- [x] Verified worker execute privilege is service_role-only; authenticated/anon cannot invoke it. Authenticated can invoke the scoped alarm read RPC; anon cannot.
- [x] Transactional tests passed for immediate warning, stale warning skip + overdue transition, reassignment immediate warning, completion cancellation, one-minute precheck, send, retry idempotency, and no notification-row writes. All synthetic changes were rolled back.
- [ ] Still pending: full browser/Preview test using a newly created assignment after the RPC contract change; test distribution-removal cancellation through the actual sync path; test concurrency/worker recovery under a deliberately interrupted transaction.
- [ ] Still pending: switch the existing cron endpoint to the event worker on Testing Preview only, after confirming Preview uses Testing Supabase credentials. Do not add a second scheduler.
- [ ] Legacy evaluator is still active and must remain so until the Testing Preview cutover is validated.

**Phase 3 status: schedule lifecycle, due-only worker, and event-backed alarm read path are implemented and database-smoke-tested on Testing.**


## Phase 3D / Testing worker routing — 14 Nov 2026

- [x] Existing `/api/cron/sla-scan` endpoint now selects the durable event worker automatically when the branch-scoped `TEST_SUPABASE_URL` is present.
- [x] Added an explicit `SLA_ENGINE_MODE=events` switch for the eventual Production cutover. Without that flag and without test mode, Production continues to call the legacy evaluator.
- [x] Verified Vercel Preview environment variables for `feat/sla-scheduling-rebuild` point to the isolated Testing Supabase project; server and browser clients both have test-specific configuration and fail closed if partially configured.
- [x] Confirmed the external cron remains the single scheduler; no Vercel Cron or second scheduler was added.
- [x] Preview build for commit `ee7908de` reached READY after adding the worker RPC type. The earlier commit `a8cbbdb` failed type-check because the worker RPC type had not yet landed; this was corrected in the subsequent commit.
- [x] Transactional RPC test verified both Collector and Admin alarm scopes return the active sent generation. Test data was rolled back.
- [ ] The current latest commit adds the explicit cutover flag; its Vercel Preview build is still running. Browser verification of the new event-backed alarm path remains pending.

**Safety rule:** Production stays on the legacy evaluator until the dedicated cutover phase. The Production migration history and environment variables have not been changed.


## Testing migration-history reconciliation — 14 Nov 2026

- [x] Aligned Phase 3 migration filenames with the actual Testing remote versions: `20261114183430`, `20261114183738`, and `20261114183842`.
- [x] The due-event worker was accidentally applied twice to Testing through the migration tool. Both applications used the same idempotent `CREATE OR REPLACE FUNCTION` definition and the live function was verified. The second remote version `20261114183818` is represented in the branch by a comment-only no-op migration so future local/remote history comparison does not attempt to replay or invent a schema change.
- [ ] Do not run a blind `supabase db push`: the repository still has pre-existing duplicate `0028` migration filenames and older remote/local history drift. Use the explicit migration list and reconcile each target before the eventual Production cutover.


## Final notification-scope clarification — 14 Nov 2026

The product decision is to retire all ordinary Admin/Collector notifications and retain only the in-site SLA alarm. Therefore:
- `assignment_sla_events` is the authoritative durable ledger for SLA Warning/Overdue processing.
- The event worker marks Warning events `sent`; it does not insert rows into `notifications` and does not use push delivery.
- The existing `notifications.sla_event_id` nullable column/index from Phase 2 is currently unused compatibility schema. It is retained to avoid unnecessary schema churn; historical notification records are not deleted.
- The browser alarm read RPC is scoped to the signed-in Admin/Collector and reads only the active generation's sent Warning event.
- Generation is included in the browser silencing key, so reassigning or rescheduling creates a fresh alarm identity.

## Additional RPC-path tests — 14 Nov 2026

- [x] Called the real `reassign_assignment` RPC under an Admin JWT context; confirmed `collector_reassigned` generation, immediate Warning event processing, activity log creation, and no notification-row insertion.
- [x] Called the real `update_assignment` RPC to move an Overdue assignment's SLA into the future; confirmed automatic restoration to Not Started and creation of a new active schedule.
- [x] Called the real `hide_assignment_from_dashboard` RPC; confirmed the active schedule is cancelled with `admin_hidden` reason.
- [x] Called the real `reconcile_distribution_presence` RPC under a service-role JWT context; confirmed removal from Distribution cancels the schedule with `distribution_removed` reason.
- [x] All synthetic assignment changes in these tests were rolled back.
