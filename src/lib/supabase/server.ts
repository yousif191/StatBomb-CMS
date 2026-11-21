// Build-time guard: importing this module from a Client Component is an
// error, not a silent bundle leak. Matters most for
// createServiceRoleClient() below, which reads SUPABASE_SERVICE_ROLE_KEY.
import "server-only";
import { createServerClient } from "@supabase/ssr";
import { createClient as createSupabaseJsClient } from "@supabase/supabase-js";
import { cookies } from "next/headers";
import type { Database } from "@/types/database.types";
import { getSupabasePublicConfig, getSupabaseSecretKey } from "@/lib/supabase/environment";

/**
 * Server Component / Route Handler / Server Action Supabase client.
 * Reads/writes the auth cookie via Next's cookies() API. Uses the public
 * anon key — RLS enforces access, exactly as it does for the browser client.
 */
export function createClient() {
  const cookieStore = cookies();

  const { url, anonKey } = getSupabasePublicConfig();

  return createServerClient<Database>(
    url,
    anonKey,
    {
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
            // Called from a Server Component with no request context to
            // write to — safe to ignore because middleware refreshes the
            // session on every request anyway.
          }
        },
      },
    }
  );
}

/**
 * Service-role client. SERVER-ONLY. Never import this from a file that can
 * end up in a Client Component bundle. Reserved for the SLA scanner and sync
 * pipeline (Phases 3 and 6) that legitimately need to bypass RLS.
 */
export function createServiceRoleClient() {
  if (typeof window !== "undefined") {
    throw new Error("createServiceRoleClient must never run in the browser.");
  }

  const { url } = getSupabasePublicConfig();

  return createSupabaseJsClient<Database>(
    url,
    getSupabaseSecretKey(),
    { auth: { autoRefreshToken: false, persistSession: false } }
  );
}
