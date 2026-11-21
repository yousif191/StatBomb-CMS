import { createBrowserClient } from "@supabase/ssr";
import type { Database } from "@/types/database.types";

/**
 * Client-component Supabase client. Uses the public anon key only — never
 * import the service-role key here or anywhere under src/.
 */
export function createClient() {
  // Vercel exposes these TEST-prefixed public values only to the isolated
  // Preview branch. Never fall back to shared credentials on that branch.
  const isTestBuild = Boolean(process.env.NEXT_PUBLIC_TEST_SUPABASE_URL);
  const url = isTestBuild
    ? process.env.NEXT_PUBLIC_TEST_SUPABASE_URL!
    : process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const anonKey = isTestBuild
    ? process.env.NEXT_PUBLIC_TEST_SUPABASE_ANON_KEY!
    : process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

  if (isTestBuild && !url.includes("cobunhmzrzyymjndmfvt.supabase.co")) {
    throw new Error("Refusing to connect this TEST build to a non-TEST Supabase project.");
  }

  return createBrowserClient<Database>(url, anonKey);
}
