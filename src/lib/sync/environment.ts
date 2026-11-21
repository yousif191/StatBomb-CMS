/**
 * Resolve Google Sheets settings without crossing environment boundaries.
 * On the dashboard-auto-sheet-sync Preview branch, only TEST-prefixed
 * credentials and spreadsheet configuration are accepted.
 */
const TEST_BRANCH = "feat/dashboard-auto-sheet-sync";

export function getGoogleSheetsEnv(name: string): string | undefined {
  if (process.env.VERCEL_GIT_COMMIT_REF !== TEST_BRANCH) {
    return process.env[name];
  }

  const aliases: Record<string, string> = {
    GOOGLE_SHEETS_SPREADSHEET_ID: "TEST_GOOGLE_SHEETS_SPREADSHEET_ID",
    GOOGLE_SHEETS_DISTRIBUTION_GID: "TEST_GOOGLE_SHEETS_DISTRIBUTION_GID",
    GOOGLE_SHEETS_MATCHES_GID: "TEST_GOOGLE_SHEETS_MATCHES_T_GID",
    GOOGLE_SHEETS_MATCHES_TAB: "TEST_GOOGLE_SHEETS_MATCHES_T_TAB",
    GOOGLE_SERVICE_ACCOUNT_EMAIL: "TEST_GOOGLE_SERVICE_ACCOUNT_EMAIL",
    GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: "TEST_GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY",
    GOOGLE_SHEETS_API_KEY: "TEST_GOOGLE_SHEETS_API_KEY",
  };

  return process.env[aliases[name] ?? `TEST_${name}`];
}
