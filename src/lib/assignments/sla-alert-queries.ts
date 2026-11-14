import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database.types";
import type { SlaAlertAssignment } from "./sla-alarm";

export type SlaAlertScope = "admin" | "collector";

/**
 * Production stays on the legacy assignment-window RPC until both server and
 * browser engine flags are switched. Testing Preview selects the event RPC
 * automatically because it is connected to the isolated TEST Supabase project.
 */
export async function getSlaAlertItems(
  client: SupabaseClient<Database>,
  scope: SlaAlertScope,
): Promise<SlaAlertAssignment[]> {
  const useEventEngine =
    Boolean(process.env.NEXT_PUBLIC_TEST_SUPABASE_URL) ||
    process.env.NEXT_PUBLIC_SLA_ENGINE_MODE === "events";

  if (useEventEngine) {
    const { data, error } = await client.rpc("get_sla_alarm_event_assignments", {
      p_scope: scope,
    });
    if (error) throw error;

    return (data ?? []).map((row) => ({
      assignmentId: row.assignment_id,
      sla: row.sla,
      status: row.status,
      homeTeam: row.home_team,
      awayTeam: row.away_team,
      competition: row.competition,
      collectorName: row.collector_name,
      half: row.half,
      task: row.task,
      generation: row.generation,
    }));
  }

  const { data, error } = await client.rpc("get_sla_alert_assignments", {
    p_scope: scope,
  });
  if (error) throw error;

  return (data ?? []).map((row) => ({
    assignmentId: row.assignment_id,
    sla: row.sla,
    status: row.status,
    homeTeam: row.home_team,
    awayTeam: row.away_team,
    competition: row.competition,
    collectorName: row.collector_name,
    half: row.half,
    task: row.task,
    generation: 0,
  }));
}
