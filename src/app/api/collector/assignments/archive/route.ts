import { NextResponse } from "next/server";
import { createClient, createServiceRoleClient } from "@/lib/supabase/server";
import { searchHistoricalAssignmentsByMatchId } from "@/lib/assignments/queries";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  // Authenticate with the caller's cookie-backed client first. All archive
  // assignment reads below continue to use this user-scoped client so RLS
  // restricts results to the signed-in collector.
  const supabase = createClient();
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();

  if (authError || !user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Read only the caller's role with the server-only service client. This
  // avoids turning a profile RLS/read failure into a misleading 403, while
  // keeping the privileged client away from the historical assignment query.
  const admin = createServiceRoleClient();
  const { data: profile, error: profileError } = await admin
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .maybeSingle();

  if (profileError) {
    console.error("Collector archive profile lookup failed", {
      userId: user.id,
      code: profileError.code,
      message: profileError.message,
    });
    return NextResponse.json(
      { error: "Could not verify collector permissions right now." },
      { status: 500 }
    );
  }

  if (String(profile?.role ?? "").trim().toLowerCase() !== "collector") {
    console.warn("Collector archive access denied", {
      userId: user.id,
      profileFound: Boolean(profile),
      role: profile?.role ?? null,
    });
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const url = new URL(request.url);
  const matchId = (url.searchParams.get("matchId") ?? "").trim();
  if (matchId.replace(/[,%_]/g, "").length < 2 || matchId.length > 80) {
    return NextResponse.json(
      { error: "Enter at least 2 characters of the Match ID." },
      { status: 400 }
    );
  }

  try {
    // Keep this query on the authenticated client: the collectorId predicate
    // and assignments RLS policy ensure collectors can only see their own work.
    const assignments = await searchHistoricalAssignmentsByMatchId(supabase, matchId, user.id);
    return NextResponse.json({ assignments });
  } catch (error) {
    console.error("Collector historical archive search failed", {
      userId: user.id,
      message: error instanceof Error ? error.message : "Unknown search error",
    });
    return NextResponse.json(
      { error: "Could not search historical assignments right now." },
      { status: 500 }
    );
  }
}
