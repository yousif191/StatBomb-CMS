# Dashboard Automatic Google Sheets Sync Plan

**Status:** Planning only — no application code, database schema, or Vercel environment variables changed.  
**Repository:** `yousif191/StatBomb-CMS`  
**Implementation branch:** `feat/dashboard-auto-sheet-sync`  
**Base branch:** `main`  
**Base commit:** `1e99c400f4e39654c5b23cd9b81923016e737695`  
**Target environment:** isolated TEST Google Sheet + TEST Supabase project + Vercel Preview deployment.  
**Production:** must remain untouched until the test is accepted.

---

## 1. Goal

Remove the Admin Dashboard's manual **Refresh Distribution** dependency. A match or assignment entered into the configured Google Sheet should be reflected in the TEST Supabase database and Dashboard automatically, without an admin pressing a button.

The behavior should match the data semantics of the existing **Match Distribution** page. In particular, use the existing shared reader:

`readDistributionRowsForMatch(matchId)`

The Dashboard must not have a second, slightly different interpretation of Distribution rows.

### Success criteria

- A new Match Master row is detected and its match metadata is available in `public.matches`.
- New Distribution rows for that Match ID are detected and reconciled into `public.assignments`.
- The Dashboard shows all valid current assignments, including incomplete assignments.
- Editing a row updates the matching assignment instead of creating a duplicate.
- Removing a row from the sheet updates `distribution_present` consistently with the existing removal behavior; it must not delete assignment history or timers.
- Temporary Google/API/network errors do not silently lose a row.
- No manual Refresh button is needed for normal operation.
- Production data and production Google Sheets are never used during this test.

---

## 2. What exists today

The current code already has useful building blocks:

| Existing file / function | Current responsibility |
|---|---|
| `src/lib/sync/google-sheets.ts` | Google Sheets API access and Distribution parsing |
| `readDistributionRowsForMatch(matchId)` | Reads Distribution rows for one Match ID using the Match Distribution parsing rules |
| `pullDistributionSheet()` | Pulls the configured Distribution tab |
| `src/app/api/matches/[matchId]/distribution/route.ts` | Match Distribution GET uses `readDistributionRowsForMatch(matchId)` |
| `src/lib/sync/reconcile-distribution-assignments.ts` | Reconciles sheet rows with assignment records |
| `src/app/api/admin/distribution/refresh/route.ts` | Current manual full refresh endpoint |
| `src/lib/assignments/queries.ts` | Admin Dashboard currently reads visible assignments from Supabase |
| `src/app/admin/RefreshDistributionButton.tsx` | Current manual Refresh Distribution UI |

### Important performance detail

Today `readDistributionRowsForMatch(matchId)` obtains the Distribution sheet data itself. Calling it separately for every match on the Dashboard could download the same whole sheet many times.

The implementation should preserve its parsing and identity semantics, but introduce a shared **single-snapshot/bulk reader** underneath it:

- Pull the configured Distribution tab once per sync run.
- Parse rows through the same shared mapper/normalizers used by `readDistributionRowsForMatch(matchId)`.
- Filter the in-memory snapshot by Match ID for each match.
- Keep `readDistributionRowsForMatch(matchId)` as the single-match interface used by Match Distribution, backed by the same parser.
- Do not implement a second Dashboard-only row mapper.

This keeps the requested function as the canonical behavior without creating an N+1 Google Sheets API problem.

---

## 3. Proposed architecture

Use **Google Apps Script edit notifications + server-side reconciliation + a scheduled safety net**.

A Google Sheet edit trigger can notify the application that a relevant tab changed. The notification is only a signal; the server must re-read the current sheet data and must not trust row values sent by the browser/script as the authoritative record.

### Flow A — Match Master tab

1. A user adds or edits a match row in the TEST Match Master tab.
2. An installable Apps Script `onEdit` trigger detects the edit.
3. Apps Script sends a small authenticated notification to a dedicated Next.js API endpoint.
4. The endpoint validates the shared secret, identifies the changed sheet/tab, and queues or starts a bounded sync.
5. The server reads the configured TEST Match Master data using the existing Match Master reader.
6. It normalizes Match ID and match fields, then idempotently upserts the matching `public.matches` row.
7. The Dashboard's next data refresh/revalidation displays the new match.

### Flow B — Distribution tab

1. A user adds or edits a Distribution row for a Match ID.
2. Apps Script notifies the same endpoint (with the Distribution tab identity).
3. The server reads the current TEST Distribution snapshot once.
4. It uses the shared Distribution parser/identity rules, including the same semantics as `readDistributionRowsForMatch(matchId)`.
5. It resolves the Match ID to `public.matches.id`, resolves HR Code to an eligible `public.profiles.id`, and validates Task, Half, SLA, and Shift Date.
6. It idempotently reconciles the sheet rows into `public.assignments`.
7. The Dashboard revalidates and shows the new/current assignment rows.

### Notification reliability and missed edits

An edit notification is not enough by itself to guarantee delivery. Therefore add:

- A durable sync-run/queue record (or equivalent existing mechanism) with states such as pending, processing, succeeded, and failed.
- A unique event/request ID so repeated notifications are harmless.
- A short debounce/coalescing window so pasting several rows does not launch many full-sheet reads.
- A scheduled incremental safety sweep to detect missed notifications and retry failed work.
- A lock so two overlapping syncs cannot race and overwrite each other's reconciliation.
- Bounded retries with backoff for transient Google API, network, and database errors.
- Clear structured logs: tab, event ID, sync start/end, rows read, rows inserted/updated/restored/skipped, and failure reason. Never log credentials or private keys.

The scheduled sweep is a recovery mechanism, not the primary user workflow. The normal path should be triggered by the sheet edit notification.

### Apps Script trigger limitations

- Use an **installable** edit trigger, not an assumption that every edit type fires a simple trigger.
- Test single-cell edits, multi-row paste, clearing cells, and edits made by a human.
- Changes made by another script/API may not fire the same edit trigger. The scheduled safety sweep must cover this case.
- If the sheet structure or tab ID changes, the integration must fail visibly and safely rather than syncing the wrong tab.

---

## 4. Reconciliation and data rules

Use the same canonical identity as Distribution reconciliation:

`Match ID + normalized HR Code + normalized Task + normalized Half`

Rules:

1. Normalize Match IDs consistently (including text-vs-number sheet cells).
2. Normalize HR Codes consistently (trim + uppercase).
3. Normalize Task and Half through the existing shared helpers.
4. Resolve collectors by HR Code and enforce the existing active/assignable profile rules.
5. Preserve existing assignment status, timers, notes, and history when a sheet row is edited.
6. Do not reset `In Progress` or `Completed` assignments to `Not Started` merely because a sync ran.
7. Do not create duplicate logical assignments when the same notification is delivered more than once.
8. When a row is removed from the current Distribution sheet, use the existing `distribution_present` lifecycle. Do not hard-delete assignments.
9. Keep `hidden_from_admin_dashboard` behavior intact.
10. Invalid rows should be reported as sync issues and should not block valid rows from being processed.
11. A Match Master row and its Distribution rows may arrive in either order. If the assignment notification arrives before the match is present in Supabase, mark it pending and retry after Match Master sync; do not silently discard it.

---

## 5. Dashboard behavior after sync

- Dashboard reads the canonical assignment records from Supabase after reconciliation.
- Dashboard counts and cards use the same visibility rules as the assignment list.
- New/changed sheet data triggers server revalidation or a lightweight client refresh event.
- Remove the manual **Refresh Distribution** button only after the automatic path and fallback sweep pass acceptance tests.
- Do not make the Dashboard call Google Sheets once per visible match.
- Do not make the browser hold or use a Supabase secret/service-role key.
- Keep the manual endpoint temporarily available but hidden/disabled during the test phase if it is useful for diagnostics. Remove it only after the automatic sync has proven reliable.

---

## 6. TEST environment isolation

The screenshot shows these TEST environment-variable names in the Vercel `statbomb-cms` project. They are names only; their values have not been supplied or verified yet.

### TEST Google Sheets variables shown

| Variable | Purpose |
|---|---|
| `TEST_GOOGLE_SHEETS_SPREADSHEET_ID` | TEST spreadsheet ID |
| `TEST_GOOGLE_SHEETS_DISTRIBUTION_GID` | TEST Distribution tab GID |
| `TEST_GOOGLE_SHEETS_MATCHES_T_GID` | TEST Match Master tab GID |
| `TEST_GOOGLE_SHEETS_MATCHES_T_TAB` | TEST Match Master tab title |
| `TEST_GOOGLE_SHEETS_MATCHES_T_TAB` | Confirm exact intended tab variable before mapping; screenshot shows this exact name |
| `TEST_GOOGLE_SHEETS_MATCHES_T_GID` | Confirm exact intended Match Master GID before mapping |
| `TEST_GOOGLE_SHEETS_MATCHES_T_TAB` | Do not infer or rename this key without confirmation |
| `TEST_GOOGLE_SHEETS_MATCHES_T_GID` | Do not infer or rename this key without confirmation |

### TEST Supabase variables shown

| Variable | Intended role |
|---|---|
| `TEST_SUPABASE_URL` | TEST Supabase project URL |
| `TEST_SUPABASE_ANON_KEY` | TEST Supabase public/anon key |
| `TEST_SUPABASE_SECRET_KEY` | TEST server-only secret key; confirm whether this is the project's current secret/service-role key |
| `NEXT_PUBLIC_TEST_SUPABASE_URL` | Screenshot shows this public-prefixed TEST URL variable |
| `NEXT_PUBLIC_TEST_SUPABASE_ANON_KEY` | Screenshot shows this public-prefixed TEST anon key variable |

**Security rule:** secret/service-role credentials must only be read in server-side code. Never use a `NEXT_PUBLIC_` prefix for a secret key. Do not copy TEST values into production variable names. Do not paste secret values into GitHub, this Markdown file, logs, or chat.

### Google authentication variables to confirm

The current Google Sheets helper uses:

- `GOOGLE_SERVICE_ACCOUNT_EMAIL`
- `GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY`

The screenshot does not show TEST-prefixed equivalents for these. Before implementation, decide whether the TEST deployment will use separate TEST service-account variables (recommended) or a deliberately shared service account with access only to the TEST spreadsheet. Do not silently reuse production Google credentials.

### Test project identity still required

The TEST Supabase project reference/ID is **not readable from the screenshot** and has not yet been provided. Record it here once confirmed:

- TEST Supabase project ref: `TBD — user to confirm`
- TEST Google spreadsheet ID: `TBD — user to confirm exact value/configuration`
- TEST Distribution GID: `TBD — verify value`
- TEST Match Master GID: `TBD — verify value`
- TEST Match Master tab title: `TBD — verify value`

Before coding, confirm that the Preview deployment can only point to the TEST Supabase project and TEST spreadsheet. Add a startup/config guard that rejects production project URLs or production spreadsheet IDs in the test branch/deployment.

---

## 7. Environment-variable mapping strategy

Do not rename or modify the existing production variables. Introduce a small server-only configuration resolver that explicitly maps the selected TEST variables to the existing reader/client configuration.

Before implementation, the user will confirm which keys to use and provide their values through Vercel's Environment Variables UI. The application code should never print values.

Required decisions:

- Which of the screenshot's TEST Google Sheet variables are authoritative?
- Should the TEST Match Master tab be configured by GID and title together?
- What are the TEST Supabase project URL and project ref?
- Is `TEST_SUPABASE_SECRET_KEY` the current secret key suitable for server-side service-role operations?
- Which TEST Google service-account credentials should be used?
- Should these variables be scoped to Preview only, or to a dedicated Vercel Preview environment/branch?

---

## 8. Implementation phases

### Phase 0 — Confirm isolation and baseline

- Confirm TEST Supabase project ref and health.
- Confirm TEST spreadsheet and exact tab IDs/titles.
- Confirm the test Google service-account access.
- Verify Vercel Preview branch variables are separate from Production.
- Capture baseline row counts and sample match/assignment records.
- No production writes.

### Phase 1 — Shared Distribution reader

- Refactor parsing so `readDistributionRowsForMatch(matchId)` and Dashboard sync use the exact same parser and normalization rules.
- Add a bulk snapshot reader to fetch the Distribution sheet once per sync.
- Add unit tests for Match ID, HR Code, Task, Half, blank rows, duplicate rows, malformed dates, and header aliases.
- Confirm Match Distribution page behavior has not changed.

### Phase 2 — Automatic notification endpoint

- Add a server-only endpoint for Apps Script notifications.
- Authenticate requests using a dedicated random TEST webhook secret.
- Validate allowed spreadsheet/tab identifiers and reject unknown tabs.
- Add event IDs, idempotency, debounce, concurrency lock, and safe logs.
- Never trust row values in the webhook body; re-read Google Sheets server-side.

### Phase 3 — Match Master and Distribution reconciliation

- Sync Match Master rows into `public.matches`.
- Sync Distribution rows into `public.assignments`.
- Reuse existing reconciliation helpers and status-preservation rules.
- Queue rows whose Match Master record is not yet available.
- Record failures for retry and diagnostics.

### Phase 4 — Apps Script and recovery sweep

- Install and test the edit trigger on the TEST spreadsheet.
- Add scheduled fallback reconciliation for missed edits and API/script-originated changes.
- Ensure both triggers use the same idempotent server endpoint.
- Confirm duplicate notifications do not create duplicate assignments.

### Phase 5 — Dashboard live update and button removal

- Revalidate the Dashboard after successful sync.
- Remove the manual Refresh Distribution button from the tested Dashboard UI.
- Verify counts, current-shift cards, filters, and assignment rows.
- Keep a controlled admin-only diagnostic/recovery path until the soak period passes.

### Phase 6 — Acceptance and production decision

- Run the acceptance checklist below on TEST.
- Monitor failures and missed-row counts over a representative work period.
- Review the implementation and test results with the user.
- Only after explicit approval, prepare a separate production rollout plan/PR. Do not deploy this branch to Production automatically.

---

## 9. Acceptance test checklist

- [ ] Add one new Match Master row; verify the match appears in TEST Supabase and Dashboard automatically.
- [ ] Add one Distribution row for that match; verify the assignment appears without pressing Refresh.
- [ ] Add Half 1 and Half 2 rows; verify both appear exactly once.
- [ ] Paste multiple Distribution rows at once; verify all valid rows are processed.
- [ ] Edit collector, task, half, SLA, or shift date; verify the correct existing logical assignment is reconciled.
- [ ] Edit an assignment already In Progress; verify status and timers are preserved.
- [ ] Remove a Distribution row; verify the existing soft-presence behavior and retained history.
- [ ] Send the same webhook twice; verify no duplicates.
- [ ] Simulate Google API failure; verify a visible failed/pending sync and later retry.
- [ ] Simulate a notification being missed; verify the scheduled safety sweep discovers it.
- [ ] Add Distribution before Match Master; verify it is retried after the match appears.
- [ ] Verify no TEST data is written to Production Supabase or Production Google Sheets.
- [ ] Verify Dashboard totals agree with the current TEST Distribution sheet.
- [ ] Verify no browser request or client bundle contains the TEST secret key.

---

## 10. Risks and safeguards

| Risk | Safeguard |
|---|---|
| Edit notification is missed | Scheduled reconciliation safety sweep |
| Repeated notifications | Idempotency key + logical assignment identity |
| Concurrent runs | Database lock / serialized sync |
| Many edits pasted together | Debounce and one sheet snapshot per run |
| Sheet row order changes | Match by normalized logical identity, not row number alone |
| Match Master arrives after Distribution | Pending/retry state |
| Temporary API failure | Backoff, retry, visible sync diagnostics |
| Wrong environment selected | TEST-only config guard and separate Preview variables |
| Status/timer overwritten | Preserve application-owned state during reconciliation |
| Dashboard stale after DB write | Server revalidation / client refresh after successful sync |

---

## 11. Out of scope for this test

- Redesigning the entire Dashboard layout or metrics.
- Changing Production environment variables.
- Writing to the Production Supabase project.
- Writing to the Production Google spreadsheet.
- Deleting assignment history or timers.
- Merging the branch or deploying to Production.

This work is limited to proving reliable automatic sheet-to-database synchronization in an isolated TEST environment.

---

## 12. Current GitHub work area

- Branch: `feat/dashboard-auto-sheet-sync`
- Base: `main`
- Plan file: `docs/plans/dashboard-auto-sheet-sync-plan.md`
- Branch purpose: isolated implementation and Preview testing only.
- No PR has been opened and no code changes have been made yet.
