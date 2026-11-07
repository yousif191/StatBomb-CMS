import { NextResponse } from "next/server";
import { createClient, createServiceRoleClient } from "@/lib/supabase/server";
import { searchHistoricalAssignmentsByMatchId } from "@/lib/assignments/queries";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const supabase = createClient();
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();

  if (authError || !user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Resolve the signed-in user's actual role server-side. The service-role
  // client is used only for this profile lookup, never for assignment data.
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
      { error: "Could not verify your account permissions right now." },
      { status: 500 }
    );
  }

  if (!profile) {
    console.warn("Collector archive profile missing", { userId: user.id });
    return NextResponse.json(
      { error: "Your login has no matching profile in the CMS. Please contact an admin." },
      { status: 403 }
    );
  }

  const role = String(profile.role ?? "").trim().toLowerCase();
  // Admin accounts are already allowed into the Collector workspace by
  // CollectorLayout. Permit the same workspace capability here as well.
  // The archive query below is still explicitly scoped to this user's ID,
  // so admin access does not expose other collectors' historical assignments.
  if (role !== "collector" && role !== "admin") {
    console.warn("Collector archive role mismatch", { userId: user.id, role });
    return NextResponse.json(
      { error: "This account cannot access the Collector workspace." },
      { status: 403 }
    );
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
    // Keep the user-scoped client and explicit user ID filter. Even admins
    // searching from the Collector workspace see only their own assignments.
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
