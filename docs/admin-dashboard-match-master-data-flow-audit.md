# Admin Dashboard and Match Master Data-Flow Audit

Branch: `feat/unify-dashboard-match-master-data`
Base: `main`
Scope: Phase 1 (read-only audit). No runtime behavior, database schema, or production deployment changes.

## Executive summary

The Admin Dashboard and Match Master both read operational data from Supabase, but they do not currently use the same assignment-selection rules.

- Match Master starts from `match_master_cache`, maps external Match IDs to internal `matches.id`, then fetches assignments for those matches. It summarizes assignments whose `distribution_present` is not false.
- The Admin Dashboard starts directly from `assignments` and requires `distribution_present = true` for selected-shift assignments. It separately includes all `In Progress` assignments (and only present `Overdue` assignments) regardless of selected shift.
- Both paths have response-size limits / bounded reads that need explicit pagination or safe completeness checks before we can claim they load all relevant records.

This explains how a match can appear in Match Master with assignment rows while being absent from the selected-shift Dashboard: the Dashboard has stricter filtering and depends on the persisted `distribution_present` flag.

## Current flow: Match Master

Source: `src/app/api/matches/master/route.ts`

1. Admin requests ETA days or matches.
2. ETA-day view calls RPC `get_match_master_eta_days`; if cache is empty, it bootstraps the cache via `syncMatchMasterCache()`.
3. Match view reads `match_master_cache` ordered by `sla_sort_at`, then `match_id`, with a hard `.limit(1000)`.
4. It resolves external IDs to internal IDs using `matches.external_id`.
5. It fetches `assignments(match_id, task, half, distribution_present)` in chunks of 400 internal match IDs.
6. It skips assignments only when `distribution_present === false`, then groups remaining rows by external Match ID and returns the distribution halves/tasks.

Important observations:
- Match Master is not reading the live Google Distribution sheet on each normal page request; it reads the Supabase Match Master cache and assignments.
- Its assignment query does not filter by `hidden_from_admin_dashboard` or shift date.
- The cache result is capped at 1,000 rows and is not paginated in this route.
- A false `distribution_present` row is excluded from the Match Master distribution summary, but the match itself can still appear in the Match Master list.

## Current flow: Admin Dashboard

Source: `src/app/admin/page.tsx` and `src/lib/assignments/queries.ts`

1. The page resolves the selected shift date (Cairo today by default, or valid `shiftDate` query parameter).
2. It calls `getAdminDashboardAssignmentsForShift(supabase, currentShiftDate)`.
3. The query function runs two Supabase reads in parallel:
   - Selected shift: `hidden_from_admin_dashboard = false`, `shift_date = selected date`, `distribution_present = true`.
   - Active work: `hidden_from_admin_dashboard = false` and status is `In Progress`, or status is `Overdue` while `distribution_present = true`.
4. It merges the two result sets by assignment ID, sorts by shift date / creation time, and attaches match records.
5. The page derives status counts and sections from this result. It also filters exact selected-shift rows in JavaScript for the Current Shift section.

Important observations:
- A selected-shift assignment with `distribution_present = false` is deliberately excluded, even if its assignment row exists and Match Master can find it.
- `In Progress` assignments are an exception: they are included even when `distribution_present = false`.
- The two assignment reads do not specify `.range()` pagination. Supabase/PostgREST commonly caps a response (often 1,000 rows), so a sufficiently large result can be silently incomplete unless the project response cap differs.
- `attachMatches()` hydrates matches in chunks, but that does not paginate the original assignment read.
- The page's `currentShiftAssignments` calculation is an additional exact-date filter; it is not the same as the full loaded set, which can include active work from other shifts.

## Root causes / risks confirmed by source

### 1. Different business filters

Match Master summarizes assignment rows for selected matches, while Dashboard applies visibility, selected shift, and distribution-presence filters. Therefore they are not equivalent views of the same selected set.

### 2. `distribution_present` is a synchronization-derived flag

Dashboard correctness depends on Refresh having read and reconciled the relevant sheet rows. Raising `GOOGLE_SHEETS_MAX_ROWS` to 7,000 fixed the user's observed case by allowing the refresh process to reach rows that had previously been outside its configured read range. This is a mitigation, not a durable dynamic-read design.

### 3. Pagination is not consistently enforced

The Dashboard query and Match Master cache query each have bounded/default response behavior without explicit full pagination in the inspected paths. The correct fix must make result completeness explicit and avoid marking records missing based on a partial source read.

### 4. Match Master is not a direct Dashboard data source

Match Master uses the cache as its match list and enriches it with assignment summaries. The Dashboard is not currently reusing that selection or a shared assignment repository function.

## Recommended target architecture

Keep Supabase as the runtime read source. Google Sheets remains the operational source of distribution changes, and Refresh reconciles those changes into Supabase.

Create a shared server-side assignment data-access layer with explicit, separately named selectors, for example:
- selected-shift assignments;
- active assignments across shifts;
- assignments for Match Master summaries.

These selectors should share normalization, pagination, row hydration, and visibility semantics where appropriate, but must not force the Dashboard and Match Master to have identical business filters. Match Master needs a per-match distribution summary; Dashboard needs shift-oriented operational assignments.

For Dashboard, prefer one bounded query strategy that:
- filters in Postgres before retrieval;
- explicitly paginates with a stable order;
- preserves the existing selected-shift and active-work semantics;
- attaches match data in bounded chunks;
- avoids loading unrelated historical completed assignments.

For Match Master:
- preserve its ETA/SLA cache behavior;
- paginate cache results or use a server-side query/RPC that returns the requested ETA day completely;
- share assignment-summary logic with the common data-access layer.

For Refresh:
- read Distribution rows dynamically in pages/batches rather than trusting a fixed 7,000-row ceiling;
- record rows read, last source row, completion status, and truncation/error state;
- only reconcile absence / set `distribution_present = false` after a confirmed complete read;
- on partial/failed reads, preserve existing presence flags and report an incomplete refresh.

## Proposed phases

### Phase 1 — Audit (this branch)
- Compare Dashboard and Match Master queries and business rules.
- Document confirmed differences and pagination risks.
- No runtime or schema changes.

### Phase 2 — Shared read layer
- Implement typed reusable query helpers and explicit pagination.
- Preserve separate Dashboard and Match Master selectors.
- Add focused tests for shift-date, active-work, hidden rows, false/true distribution flags, and duplicate halves.

### Phase 3 — Dashboard migration
- Switch Dashboard to the shared selectors.
- Keep current UI and status grouping unchanged.
- Add diagnostics for selected-shift count, active count, and pagination completeness.

### Phase 4 — Match Master migration
- Reuse shared assignment-summary logic.
- Make cache result completeness explicit without changing ETA/SLA ordering.

### Phase 5 — Refresh hardening
- Implement dynamic/batched Google Sheet reads.
- Prevent destructive absence reconciliation after incomplete reads.
- Retain 7,000 as a temporary operational ceiling only if needed during rollout, not as the correctness mechanism.

### Phase 6 — Verification and rollout
- Test known cases (including Match IDs 5008781, 1451470, and 5008680) against Sheet rows, Supabase assignments, Match Master summaries, and Dashboard output.
- Compare counts and timings before/after.
- Deploy only after Preview validation.

## Safety constraints

- Do not change production data as part of query refactoring.
- Do not rewrite assignment statuses, shift dates, collector IDs, halves, or tasks.
- Do not auto-create or delete assignments to make the two pages' counts match.
- Do not set `distribution_present = false` unless the full Distribution source read completed successfully.
- Preserve the existing distinction between current shift, active work from other shifts, and historical archive results.
