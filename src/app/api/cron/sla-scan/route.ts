import { timingSafeEqual } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { createServiceRoleClient, isSlaTestEnvironment } from "@/lib/supabase/server";

/**
 * The existing external cron-job.org schedule calls this endpoint once per
 * minute. Production continues using the legacy evaluator until cutover.
 * Feature-branch Preview deployments with TEST_SUPABASE_URL use the durable
 * event worker against the isolated Testing project. No second scheduler is
 * introduced and the Production database is never selected in test mode.
 */

// Never prerender or cache: this must execute on every invocation.
export const dynamic = "force-dynamic";
// node:crypto + the service-role client require the Node runtime.
export const runtime = "nodejs";

/** Constant-time secret comparison — avoids leaking the secret via timing. */
function secretMatches(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  // timingSafeEqual throws on length mismatch, so compare lengths first.
  // Length is not sensitive here; the secret's contents are.
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Accepts the secret either as `Authorization: Bearer <secret>` (what Vercel
 * Cron sends automatically when CRON_SECRET is set) or as an explicit
 * `x-cron-secret` header (for manual/other schedulers).
 */
function isAuthorized(request: NextRequest): boolean {
  const expected = process.env.CRON_SECRET;

  // Fail closed: an unset/empty secret must never mean "open endpoint".
  if (!expected) return false;

  const authHeader = request.headers.get("authorization");
  if (authHeader?.startsWith("Bearer ")) {
    if (secretMatches(authHeader.slice("Bearer ".length), expected)) return true;
  }

  const headerSecret = request.headers.get("x-cron-secret");
  if (headerSecret && secretMatches(headerSecret, expected)) return true;

  return false;
}

async function runScan(request: NextRequest) {
  if (!isAuthorized(request)) {
    // Deliberately terse: no hint about whether CRON_SECRET is configured.
    console.warn("[sla-scan] rejected unauthorized request");
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const startedAt = Date.now();

  try {
    const supabase = createServiceRoleClient();
    const isTestEngine = isSlaTestEnvironment();
    const { data, error } = isTestEngine
      ? await supabase.rpc("process_assignment_sla_events", { p_batch_size: 100 })
      : await supabase.rpc("evaluate_assignment_sla_states");

    if (error) {
      // Log server-side detail; return nothing internal to the caller.
      console.error("[sla-scan] rpc failed", {
        message: error.message,
        code: error.code,
        durationMs: Date.now() - startedAt,
      });
      return NextResponse.json({ error: "sla_scan_failed" }, { status: 500 });
    }

    const durationMs = Date.now() - startedAt;

    if (isTestEngine) {
      const result = data?.[0] ?? {
        processed: 0, warnings_sent: 0, overdue_marked: 0,
        cancelled: 0, skipped: 0, prechecked: 0,
      };
      console.info("[sla-scan] event worker completed", { ...result, durationMs });
      return NextResponse.json({ ok: true, engine: "event_queue", ...result, durationMs });
    }

    const result = data?.[0] ?? { warnings_fired: 0, overdue_fired: 0 };
    console.info("[sla-scan] legacy evaluator completed", {
      warningsFired: result.warnings_fired,
      overdueFired: result.overdue_fired,
      durationMs,
    });
    return NextResponse.json({
      ok: true,
      engine: "legacy",
      warningsFired: result.warnings_fired,
      overdueFired: result.overdue_fired,
      durationMs,
    });
  } catch (cause) {
    // Covers a missing SUPABASE_SERVICE_ROLE_KEY, network failure, etc. A
    // failed run loses no state — the next tick re-evaluates from scratch.
    console.error("[sla-scan] unexpected failure", {
      message: cause instanceof Error ? cause.message : String(cause),
      durationMs: Date.now() - startedAt,
    });
    return NextResponse.json({ error: "sla_scan_failed" }, { status: 500 });
  }
}

// Vercel Cron issues GET requests; POST is kept for manual/other triggers.
export async function GET(request: NextRequest) {
  return runScan(request);
}

export async function POST(request: NextRequest) {
  return runScan(request);
}
