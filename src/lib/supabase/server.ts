// Build-time guard: importing this module from a Client Component is an
// error, not a silent bundle leak. Matters most for service-role credentials.
import "server-only";
import { createServerClient } from "@supabase/ssr";
import { createClient as createSupabaseJsClient } from "@supabase/supabase-js";
import { cookies } from "next/headers";
import type { Database } from "@/types/database.types";

function getSupabaseConfig() {
  // TEST_SUPABASE_URL exists only on the SLA testing Vercel branch.
  // Never fall back to Production when test mode is partially configured.
  const testUrl = process.env.TEST_SUPABASE_URL;
  if (testUrl) {
    const anonKey = process.env.TEST_SUPABASE_ANON_KEY;
    const serviceRoleKey = process.env.TEST_SUPABASE_SECRET_KEY;
    if (!anonKey || !serviceRoleKey) {
      throw new Error("SLA test Supabase is partially configured; refusing Production fallback.");
    }
    return { url: testUrl, anonKey, serviceRoleKey, isTest: true };
  }

  return {
    url: process.env.NEXT_PUBLIC_SUPABASE_URL!,
    anonKey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY!,
    isTest: false,
  };
}

/** Server Component / Route Handler / Server Action client; RLS remains active. */
export function createClient() {
  const config = getSupabaseConfig();
  const cookieStore = cookies();

  return createServerClient<Database>(config.url, config.anonKey, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          cookiesToSet.forEach(({ name, value, options }) => {
            cookieStore.set(name, value, options);
          });
        } catch {
          // Server Components cannot write cookies; middleware refreshes sessions.
        }
      },
    },
  });
}

/** Server-only service-role client for trusted server workflows. */
export function createServiceRoleClient() {
  if (typeof window !== "undefined") {
    throw new Error("createServiceRoleClient must never run in the browser.");
  }

  const config = getSupabaseConfig();
  return createSupabaseJsClient<Database>(config.url, config.serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

/** Used by server integrations to disable Production-only schedulers in test mode. */
export function isSlaTestEnvironment(): boolean {
  return Boolean(process.env.TEST_SUPABASE_URL);
}
