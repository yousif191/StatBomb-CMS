import { NextResponse } from "next/server";
import { syncMatchMasterCache } from "@/lib/match-master-cache-sync";
import { isSlaTestEnvironment } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(request: Request) {
  // The production Match Master scheduler must never run in the isolated SLA branch.
  if (isSlaTestEnvironment()) {
    return NextResponse.json({ error: "Match Master production scheduler is disabled in SLA test mode." }, { status: 404 });
  }

  const secret = process.env.MATCH_MASTER_CRON_SECRET;
  const authorization = request.headers.get("authorization");
  if (!secret || authorization !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  try {
    const result = await syncMatchMasterCache();
    return NextResponse.json({ success: true, ...result });
  } catch (error) {
    console.error("Scheduled Match Master cache sync failed", error);
    return NextResponse.json({ error: "Match Master cache sync failed." }, { status: 500 });
  }
}
