import { createBrowserClient } from "@supabase/ssr";
import type { Database } from "@/types/database.types";

/**
 * Client-component Supabase client.
 * Test credentials are branch-scoped in Vercel and deliberately fail closed:
 * when the test URL is present, missing test keys never fall back to Production.
 */
export function createClient() {
  const testUrl = process.env.NEXT_PUBLIC_TEST_SUPABASE_URL;
  if (testUrl) {
    const testKey = process.env.NEXT_PUBLIC_TEST_SUPABASE_ANON_KEY;
    if (!testKey) {
      throw new Error("SLA test Supabase is partially configured; refusing Production fallback.");
    }
    return createBrowserClient<Database>(testUrl, testKey);
  }

  return createBrowserClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  );
}
