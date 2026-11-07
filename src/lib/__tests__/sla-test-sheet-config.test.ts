import { describe, expect, it } from "vitest";
import {
  assertSlaTestWriteTarget,
  getSlaTestTab,
  SLA_TEST_SHEET,
} from "@/lib/sla/test-sheet-config";

describe("SLA test-sheet write isolation", () => {
  it("accepts only the dedicated test spreadsheet ID", () => {
    expect(() => assertSlaTestWriteTarget(SLA_TEST_SHEET.spreadsheetId)).not.toThrow();
  });

  it("rejects the primary spreadsheet ID", () => {
    expect(() =>
      assertSlaTestWriteTarget("1gT8xUWKw-83xIYCXtYXJZU1S4M87JpapM-ROBqF_KgQ")
    ).toThrow(/Blocked SLA test write/);
  });

  it("rejects unknown spreadsheet IDs", () => {
    expect(() => assertSlaTestWriteTarget("unknown-spreadsheet")).toThrow(
      /Blocked SLA test write/
    );
  });

  it("exposes only the two explicitly configured tabs", () => {
    expect(getSlaTestTab("distribution")).toEqual({
      title: "Distribution",
      gid: 1488672064,
    });
    expect(getSlaTestTab("matches")).toEqual({
      title: "Matches (T)",
      gid: 1821199165,
    });
  });

  it("keeps the test target fixed in branch code, independent of environment variables", () => {
    const original = process.env.GOOGLE_SHEETS_SPREADSHEET_ID;
    process.env.GOOGLE_SHEETS_SPREADSHEET_ID =
      "1gT8xUWKw-83xIYCXtYXJZU1S4M87JpapM-ROBqF_KgQ";
    try {
      expect(() =>
        assertSlaTestWriteTarget(SLA_TEST_SHEET.spreadsheetId)
      ).not.toThrow();
      expect(() =>
        assertSlaTestWriteTarget(process.env.GOOGLE_SHEETS_SPREADSHEET_ID!)
      ).toThrow(/Blocked SLA test write/);
    } finally {
      if (original === undefined) delete process.env.GOOGLE_SHEETS_SPREADSHEET_ID;
      else process.env.GOOGLE_SHEETS_SPREADSHEET_ID = original;
    }
  });
});
