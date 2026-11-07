/**
 * SLA rebuild test spreadsheet configuration.
 *
 * These IDs are intentionally branch-local constants, not environment variables.
 * Never replace this with the production spreadsheet in this test module.
 * Google service-account credentials remain server-side environment secrets.
 */
export const SLA_TEST_SHEET = Object.freeze({
  mode: "test" as const,
  spreadsheetId: "1aWy8wMquLBR0jROfg0n9k4ONSvVu2sjPGpf-JjgeJ8M",
  tabs: Object.freeze({
    distribution: Object.freeze({
      title: "Distribution",
      gid: 1488672064,
    }),
    matches: Object.freeze({
      title: "Matches (T)",
      gid: 1821199165,
    }),
  }),
});

const PRODUCTION_SPREADSHEET_ID = "1gT8xUWKw-83xIYCXtYXJZU1S4M87JpapM-ROBqF_KgQ";

/**
 * Every test-sheet write must pass this guard immediately before the API call.
 * The target ID is checked explicitly so an accidental env/config fallback
 * cannot redirect test writes to the production spreadsheet.
 */
export function assertSlaTestWriteTarget(spreadsheetId: string): void {
  if (
    SLA_TEST_SHEET.mode !== "test" ||
    spreadsheetId !== SLA_TEST_SHEET.spreadsheetId ||
    spreadsheetId === PRODUCTION_SPREADSHEET_ID
  ) {
    throw new Error("Blocked SLA test write: target is not the dedicated test spreadsheet.");
  }
}

/** Resolve only the two tabs approved for SLA test operations. */
export function getSlaTestTab(tab: "distribution" | "matches") {
  return SLA_TEST_SHEET.tabs[tab];
}
