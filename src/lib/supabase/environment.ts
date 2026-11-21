/**
 * Branch-aware integration configuration.
 *
 * The dashboard-auto-sheet-sync Preview branch must never fall back to
 * shared/production credentials. All TEST variables are scoped to that
 * single Vercel Preview branch.
 */
export const DASHBOARD_AUTO_SHEET_TEST_BRANCH = "feat/dashboard-auto-sheet-sync";
export const TEST_SUPABASE_PROJECT_REF = "cobunhmzrzyymjndmfvt";

export function isDashboardAutoSheetTestBranch(): boolean {
  return (
    process.env.VERCEL_GIT_COMMIT_REF === DASHBOARD_AUTO_SHEET_TEST_BRANCH ||
    Boolean(process.env.NEXT_PUBLIC_TEST_SUPABASE_URL)
  );
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function assertTestSupabaseUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("TEST_SUPABASE_URL must be a valid URL.");
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.hostname !== `${TEST_SUPABASE_PROJECT_REF}.supabase.co`
  ) {
    throw new Error("Refusing to connect this Preview branch to a non-TEST Supabase project.");
  }
  return url;
}

export function getSupabasePublicConfig() {
  if (isDashboardAutoSheetTestBranch()) {
    return {
      url: assertTestSupabaseUrl(requiredEnv("TEST_SUPABASE_URL")),
      anonKey: requiredEnv("TEST_SUPABASE_ANON_KEY"),
    };
  }

  return {
    url: requiredEnv("NEXT_PUBLIC_SUPABASE_URL"),
    anonKey: requiredEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY"),
  };
}

export function getSupabaseSecretKey(): string {
  return isDashboardAutoSheetTestBranch()
    ? requiredEnv("TEST_SUPABASE_SECRET_KEY")
    : requiredEnv("SUPABASE_SERVICE_ROLE_KEY");
}
