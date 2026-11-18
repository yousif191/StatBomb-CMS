import type { SupabaseClient } from "@supabase/supabase-js";
import type { AssignmentStatus, AssignmentTaskTimerRow, Database, MatchRow } from "@/types/database.types";
import type { AssignmentWithMatch } from "./types";
import { fetchAllPages } from "./query-pagination";
import { normalizeDistributionHalf, normalizeDistributionTask, normalizeMatchId } from "@/lib/sync/distribution-identity";
import { isCurrentShiftDate, parseCalendarDate } from "@/lib/dates";
import { readAllDistributionRows, normalizeDistributionCollectorHrCode } from "@/lib/sync/google-sheets";

type Client = SupabaseClient<Database>;

function queryErrorFields(error: unknown): { message: string; code: string; details: string; hint: string } {
  const candidate = error && typeof error === "object" ? (error as Record<string, unknown>) : {};
  return {
    message: candidate.message == null ? "" : String(candidate.message),
    code: candidate.code == null ? "" : String(candidate.code),
    details: candidate.details == null ? "" : String(candidate.details),
    hint: candidate.hint == null ? "" : String(candidate.hint),
  };
}

function assignmentQueryCounts(assignments: Database["public"]["Tables"]["assignments"]["Row"][]) {
  return {
    assignmentCount: assignments.length,
    uniqueMatchIds: new Set(assignments.map((assignment) => assignment.match_id)).size,
    uniqueCollectorIds: new Set(assignments.map((assignment) => assignment.collector_id)).size,
  };
}

/**
 * Nested `select("*, match:matches(*)")` typing doesn't infer well against
 * our hand-written Database type (empty `Relationships` — see
 * database.types.ts's regeneration note), so assignments and their
 * matches are fetched separately and joined in JS. Keeps the types honest
 * instead of casting through `any`.
 */
const MATCH_ID_CHUNK_SIZE = 100;
const ASSIGNMENTS_PAGE_SIZE = 1000;

async function attachMatches(
  supabase: Client,
  assignments: Database["public"]["Tables"]["assignments"]["Row"][]
): Promise<AssignmentWithMatch[]> {
  if (assignments.length === 0) return [];

  const matchIds = [...new Set(assignments.map((a) => a.match_id))];
  const counts = assignmentQueryCounts(assignments);
  console.error("Admin dashboard query start", {
    query: "attachMatches matches query",
    ...counts,
  });

  const matches: MatchRow[] = [];
  const matchChunks: string[][] = [];
  for (let i = 0; i < matchIds.length; i += MATCH_ID_CHUNK_SIZE) {
    matchChunks.push(matchIds.slice(i, i + MATCH_ID_CHUNK_SIZE));
  }

  // Avoid serial round trips for large dashboards while keeping query sizes bounded.
  const MATCH_QUERY_CONCURRENCY = 8;
  for (let i = 0; i < matchChunks.length; i += MATCH_QUERY_CONCURRENCY) {
    const chunkResults = await Promise.all(
      matchChunks.slice(i, i + MATCH_QUERY_CONCURRENCY).map(async (chunk) => {
        const { data, error } = await supabase
          .from("matches")
          .select("*")
          .in("id", chunk);
        if (error) {
          console.error("Admin dashboard query failed", {
            query: "attachMatches matches query",
            ...counts,
            ...queryErrorFields(error),
          });
          throw error;
        }
        return data ?? [];
      }),
    );
    for (const rows of chunkResults) matches.push(...rows);
  }

  console.error("Admin dashboard query complete", {
    query: "attachMatches matches query",
    ...counts,
    matchesReturned: matches.length,
  });

  const byId = new Map<string, MatchRow>(matches.map((m) => [m.id, m]));

  return assignments
    .filter((a) => byId.has(a.match_id))
    .map((a) => ({ ...a, match: byId.get(a.match_id)! }));
}

/** All assignments belonging to one collector (RLS also enforces this). */
export async function getAssignmentsForCollector(
  supabase: Client,
  collectorId: string
): Promise<AssignmentWithMatch[]> {
  const { data, error } = await supabase
    .from("assignments")
    .select("*")
    .eq("collector_id", collectorId);

  if (error) throw error;
  return attachMatches(supabase, data ?? []);
}


/** Fetch task timers only for assignments already narrowed by the calling page. */
export async function getAssignmentTaskTimersForAssignments(
  supabase: Client,
  assignmentIds: string[]
): Promise<AssignmentTaskTimerRow[]> {
  if (assignmentIds.length === 0) return [];
  const rows: AssignmentTaskTimerRow[] = [];
  const chunkSize = 100;
  for (let i = 0; i < assignmentIds.length; i += chunkSize) {
    const { data, error } = await supabase
      .from("assignment_task_timers")
      .select("*")
      .in("assignment_id", assignmentIds.slice(i, i + chunkSize))
      .order("started_at", { ascending: true });
    if (error) throw error;
    rows.push(...(data ?? []));
  }
  return rows;
}

/** Admin analytics assignments constrained in Postgres before match hydration. */
export async function getAdminShiftAnalysisAssignments(
  supabase: Client,
  filters: { from?: string; to?: string; status?: AssignmentStatus }
): Promise<AssignmentWithMatch[]> {
  let query = supabase.from("assignments").select("*");
  if (filters.from) query = query.gte("shift_date", filters.from);
  if (filters.to) query = query.lte("shift_date", filters.to);
  if (filters.status) query = query.eq("status", filters.status);
  const { data, error } = await query.order("shift_date", { ascending: false });
  if (error) throw error;
  return attachMatches(supabase, data ?? []);
}

/** All assignments visible to the caller (admin — RLS allows this). */
export async function getAllAssignments(supabase: Client): Promise<AssignmentWithMatch[]> {
  // Fetch every page in a stable order; the shared helper prevents silent
  // truncation at the PostgREST response limit.
  const assignments = await fetchAllPages((from, to) =>
    supabase
      .from("assignments")
      .select("*")
      .order("id", { ascending: true })
      .range(from, to),
    ASSIGNMENTS_PAGE_SIZE,
  );

  return attachMatches(supabase, assignments);
}

/** Admin Dashboard assignments. Hidden rows remain in the database and history. */
export async function getAdminDashboardAssignments(supabase: Client): Promise<AssignmentWithMatch[]> {
  console.error("Admin dashboard query start", {
    query: "admin assignments query",
  });

  // Keep the existing selector semantics; only paging is shared here.
  const assignments = await fetchAllPages(
    (from, to) =>
      supabase
        .from("assignments")
        .select("*")
        .eq("hidden_from_admin_dashboard", false)
        .eq("distribution_present", true)
        .order("id", { ascending: true })
        .range(from, to),
    ASSIGNMENTS_PAGE_SIZE,
  );

  console.error("Admin dashboard query complete", {
    query: "admin assignments query",
    ...assignmentQueryCounts(assignments),
  });
  return attachMatches(supabase, assignments);
}

export async function getAssignmentById(
  supabase: Client,
  assignmentId: string
): Promise<AssignmentWithMatch | null> {
  const { data, error } = await supabase
    .from("assignments")
    .select("*")
    .eq("id", assignmentId)
    .maybeSingle();

  if (error) throw error;
  if (!data) return null;

  const [withMatch] = await attachMatches(supabase, [data]);
  return withMatch ?? null;
}

export async function getMatchCollaborators(supabase: Client, matchId: string) {
  const { data, error } = await supabase.rpc("get_match_collaborators", {
    p_match_id: matchId,
  });
  if (error) throw error;
  return data ?? [];
}

export async function getMatchCollaboratorsWithContacts(supabase: Client, matchId: string) {
  const { data, error } = await supabase.rpc("get_match_collaborators_contact", {
    p_match_id: matchId,
  });
  if (error) throw error;
  return data ?? [];
}

export async function getCollectorTeammates(supabase: Client) {
  const { data, error } = await supabase.rpc("get_collector_teammates");
  if (error) throw error;
  return data ?? [];
}

export async function getAssignmentTaskTimers(
  supabase: Client,
  assignmentId: string
): Promise<AssignmentTaskTimerRow[]> {
  const { data, error } = await supabase
    .from("assignment_task_timers")
    .select("*")
    .eq("assignment_id", assignmentId)
    .order("started_at", { ascending: true });

  if (error) throw error;
  return data ?? [];
}


/**
 * Small, live subset for the shared admin shell. The shell only renders SLA
 * alerts, so completed historical assignments are intentionally not fetched
 * on every admin route transition.
 */
export async function getAdminSlaAlertAssignments(supabase: Client): Promise<AssignmentWithMatch[]> {
  const { data, error } = await supabase
    .from("assignments")
    .select("*")
    .eq("hidden_from_admin_dashboard", false)
    .eq("distribution_present", true)
    .neq("status", "Completed");

  if (error) throw error;
  return attachMatches(supabase, data ?? []);
}

/**
 * Small, live subset for the collector shell. Include assignments still
 * present in the active distribution plus in-progress/overdue work, but never
 * load completed historical work just to build navigation SLA alerts.
 */
export async function getCollectorSlaAlertAssignments(
  supabase: Client,
  collectorId: string
): Promise<AssignmentWithMatch[]> {
  const { data, error } = await supabase
    .from("assignments")
    .select("*")
    .eq("collector_id", collectorId)
    .neq("status", "Completed")
    .or('distribution_present.eq.true,status.eq."In Progress",status.eq."Overdue"');

  if (error) throw error;
  return attachMatches(supabase, data ?? []);
}


/**
 * Admin dashboard query: read assignments from the selected shift's live
 * Distribution sheet and enrich them with matching Supabase workflow records.
 */
export async function getAdminDashboardAssignmentsForShift(
  supabase: Client,
  shiftDate: string
): Promise<AssignmentWithMatch[]> {
  // Live Google Distribution is the source of truth for what is assigned
  // to the selected shift. Supabase provides optional workflow records.
  const [distributionRows, databaseAssignments, matchesResult, profilesResult] = await Promise.all([
    readAllDistributionRows(),
    fetchAllPages((from, to) =>
      supabase.from("assignments").select("*")
        .eq("hidden_from_admin_dashboard", false)
        .order("id", { ascending: true }).range(from, to),
      ASSIGNMENTS_PAGE_SIZE,
    ),
    supabase.from("matches").select("*"),
    supabase.from("profiles").select("id, hr_code, full_name, email"),
  ]);
  if (matchesResult.error) throw matchesResult.error;
  if (profilesResult.error) throw profilesResult.error;

  const matches = matchesResult.data ?? [];
  const profiles = profilesResult.data ?? [];
  const selectedRows = distributionRows.filter((row) => isCurrentShiftDate(row.shift_date, shiftDate));
  const matchByExternalId = new Map(matches.map((match) => [normalizeMatchId(match.external_id), match] as const));
  const profileByHr = new Map(profiles.filter((profile) => profile.hr_code)
    .map((profile) => [normalizeDistributionCollectorHrCode(profile.hr_code) ?? "", profile] as const));
  const profileById = new Map(profiles.map((profile) => [profile.id, profile] as const));
  const matchByInternalId = new Map(matches.map((match) => [match.id, match] as const));
  const assignmentByIdentity = new Map<string, Database["public"]["Tables"]["assignments"]["Row"]>();

  for (const assignment of databaseAssignments) {
    const match = matchByInternalId.get(assignment.match_id);
    const profile = profileById.get(assignment.collector_id);
    if (!match || !profile?.hr_code) continue;
    const key = dashboardDistributionKey(match.external_id, profile.hr_code, assignment.task, assignment.half);
    if (!assignmentByIdentity.has(key)) assignmentByIdentity.set(key, assignment);
  }

  const now = new Date().toISOString();
  const result: AssignmentWithMatch[] = [];
  for (const row of selectedRows) {
    const externalId = normalizeMatchId(row.match_id);
    if (!externalId) continue;
    const match = matchByExternalId.get(externalId);
    const hrCode = normalizeDashboardHrCode(row.collector_hr_code);
    const task = normalizeDistributionTask(row.task);
    const half = normalizeDistributionHalf(row.half);
    const shiftDateIso = parseCalendarDate(row.shift_date, "dmy");
    if (!match || !hrCode || !task || !half || !shiftDateIso) continue;

    const identity = dashboardDistributionKey(externalId, hrCode, task, half);
    const existing = assignmentByIdentity.get(identity);
    const collector = profileByHr.get(hrCode);
    const parsedSla = parseDashboardDistributionSla(row.sla);
    const fallbackSla = parsedSla ?? new Date(`${shiftDateIso}T23:59:59+02:00`).toISOString();
    const status = dashboardStatusFromSheet(row.status, existing?.status ?? "Not Started");

    if (existing) {
      result.push({
        ...existing,
        shift_date: shiftDateIso,
        sla: parsedSla ?? existing.sla,
        status,
        distribution_present: true,
        notes: row.hyper_care_notes ?? existing.notes,
        match,
      });
      continue;
    }

    // Sheet-only rows are display-only until Refresh creates their real DB record.
    result.push({
      id: `sheet:${row.raw_row_number}:${identity}`,
      match_id: match.id,
      collector_id: collector?.id ?? `sheet-collector:${hrCode}`,
      previous_collector_id: null,
      raw_task_value: row.task ?? task,
      task,
      half: half as Database["public"]["Tables"]["assignments"]["Row"]["half"],
      sla: fallbackSla,
      shift_date: shiftDateIso,
      status,
      started_at: null,
      completed_at: null,
      sla_warning_sent_at: null,
      overdue_notified_at: null,
      notes: row.hyper_care_notes,
      distribution_present: true,
      hidden_from_admin_dashboard: false,
      created_at: now,
      updated_at: now,
      match,
    });
  }

  return result.sort((left, right) =>
    String(left.sla).localeCompare(String(right.sla)) ||
    String(left.match.external_id).localeCompare(String(right.match.external_id))
  );
}

function normalizeDashboardHrCode(value: string | null | undefined): string {
  return String(value ?? "").trim().toUpperCase();
}

function dashboardDistributionKey(matchId: string, hrCode: string, task: string, half: string): string {
  return [
    normalizeMatchId(matchId),
    normalizeDashboardHrCode(hrCode),
    normalizeDistributionTask(task),
    normalizeDistributionHalf(half),
  ].join("|");
}

function dashboardStatusFromSheet(value: string | null, fallback: AssignmentStatus): AssignmentStatus {
  const status = String(value ?? "").trim().toLowerCase();
  if (status === "complete" || status === "completed") return "Completed";
  if (status === "in progress" || status === "in-progress") return "In Progress";
  if (status === "not started" || status === "not-started") return "Not Started";
  return fallback;
}

function parseDashboardDistributionSla(value: string | null): string | null {
  const text = String(value ?? "").trim();
  if (!text) return null;
  const parsed = new Date(text);
  if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
  const match = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2})(?:\s*([AaPp][Mm]))?)?$/);
  if (!match) return null;
  const first = Number(match[1]);
  const second = Number(match[2]);
  const month = first > 12 ? second : first;
  const day = first > 12 ? first : second;
  const year = Number(match[3]);
  const rawHour = Number(match[4] ?? 0);
  const minute = Number(match[5] ?? 0);
  const meridiem = match[6]?.toLowerCase();
  const hour = meridiem === "pm" && rawHour < 12 ? rawHour + 12 : meridiem === "am" && rawHour === 12 ? 0 : rawHour;
  const instant = new Date(Date.UTC(year, month - 1, day, hour - 2, minute));
  return Number.isNaN(instant.getTime()) ? null : instant.toISOString();
}

/**
 * Collector dashboard query: current distribution and genuinely active work only.
 * Stale Overdue assignments whose Distribution rows were removed/reassigned are
 * hidden; In Progress work and recent completions remain visible. Older completed
 * assignments are retrieved through archive search.
 */
export async function getCollectorDashboardAssignmentsForShift(
  supabase: Client,
  collectorId: string,
  shiftDate: string
): Promise<AssignmentWithMatch[]> {
  const recentCompletionCutoff = new Date(Date.now() - 36 * 60 * 60 * 1000).toISOString();
  const { data, error } = await supabase
    .from("assignments")
    .select("*")
    .eq("collector_id", collectorId)
    // Always include every assignment for the selected shift, including older
    // completed work. The previous 36-hour completion cutoff accidentally hid
    // completed assignments when the collector selected an older shift.
    // Outside that shift, load only live unfinished distribution rows, active
    // work, and recent completions. Older history remains on-demand in the archive.
    .or(`shift_date.eq.${shiftDate},and(distribution_present.eq.true,status.neq."Completed"),status.eq."In Progress",completed_at.gte.${recentCompletionCutoff}`)
    .order("shift_date", { ascending: false })
    .order("created_at", { ascending: false });

  if (error) throw error;
  return attachMatches(supabase, data ?? []);
}

/** Explicit archive lookup by Match ID; called only when an admin/collector searches. */
export async function searchHistoricalAssignmentsByMatchId(
  supabase: Client,
  query: string,
  collectorId?: string
): Promise<AssignmentWithMatch[]> {
  const normalizedQuery = query.trim().replace(/[,%_]/g, "");
  if (normalizedQuery.length < 2 || normalizedQuery.length > 80) return [];

  const { data: matches, error: matchesError } = await supabase
    .from("matches")
    .select("id, external_id")
    .ilike("external_id", `%${normalizedQuery}%`)
    .limit(50);

  if (matchesError) throw matchesError;
  const matchIds = (matches ?? []).map((match) => match.id);
  if (matchIds.length === 0) return [];

  let assignmentsQuery = supabase
    .from("assignments")
    .select("*")
    .in("match_id", matchIds)
    .order("created_at", { ascending: false })
    .limit(100);

  if (collectorId) {
    assignmentsQuery = assignmentsQuery.eq("collector_id", collectorId);
  }

  const { data: assignments, error: assignmentsError } = await assignmentsQuery;
  if (assignmentsError) throw assignmentsError;
  return attachMatches(supabase, assignments ?? []);
}


export type MatchMasterDistributionSummary = {
  halves: string[];
  tasks: string[];
};

/**
 * Fetch and aggregate Match Master distribution rows using the shared,
 * explicitly paginated assignment reader. Only an explicit false presence
 * flag is excluded, preserving Match Master's established NULL semantics.
 */
export async function getMatchMasterDistributionSummaries(
  supabase: Client,
  matchIds: string[],
): Promise<Map<string, MatchMasterDistributionSummary>> {
  const summaries = new Map<string, { halves: Set<string>; tasks: Set<string> }>();
  const uniqueMatchIds = [...new Set(matchIds)];
  const chunkSize = 400;

  for (let offset = 0; offset < uniqueMatchIds.length; offset += chunkSize) {
    const chunk = uniqueMatchIds.slice(offset, offset + chunkSize);
    const assignments = await fetchAllPages(
      (from, to) =>
        supabase
          .from("assignments")
          .select("id, match_id, task, half, distribution_present")
          .in("match_id", chunk)
          .order("id", { ascending: true })
          .range(from, to),
      ASSIGNMENTS_PAGE_SIZE,
    );

    for (const assignment of assignments) {
      if (assignment.distribution_present === false) continue;

      const current = summaries.get(assignment.match_id) ?? {
        halves: new Set<string>(),
        tasks: new Set<string>(),
      };
      current.halves.add(normalizeDistributionHalf(assignment.half));
      const task = String(assignment.task ?? "").trim();
      if (task) current.tasks.add(task);
      summaries.set(assignment.match_id, current);
    }
  }

  return new Map(
    [...summaries.entries()].map(([matchId, summary]) => [
      matchId,
      {
        halves: [...summary.halves].sort((a, b) => a.localeCompare(b, undefined, { numeric: true })),
        tasks: [...summary.tasks].sort((a, b) => a.localeCompare(b)),
      },
    ]),
  );
}
