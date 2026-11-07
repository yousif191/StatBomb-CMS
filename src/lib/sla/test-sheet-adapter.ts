import "server-only";

import {
  assertSlaTestWriteTarget,
  getSlaTestTab,
  SLA_TEST_SHEET,
} from "@/lib/sla/test-sheet-config";
import { googleRequest } from "@/lib/sync/google-sheets";

const API = "https://sheets.googleapis.com/v4/spreadsheets";

type TabKey = "distribution" | "matches";
type SheetProperties = {
  properties?: {
    sheetId?: number;
    title?: string;
    gridProperties?: { rowCount?: number; columnCount?: number };
  };
};

function spreadsheetUrl(path = ""): string {
  return `${API}/${encodeURIComponent(SLA_TEST_SHEET.spreadsheetId)}${path}`;
}

function quoteTitle(title: string): string {
  return `'${title.replace(/'/g, "''")}'`;
}

function columnName(index: number): string {
  let value = index + 1;
  let result = "";
  while (value > 0) {
    const remainder = (value - 1) % 26;
    result = String.fromCharCode(65 + remainder) + result;
    value = Math.floor((value - 1) / 26);
  }
  return result;
}

async function resolveTab(tab: TabKey) {
  const expected = getSlaTestTab(tab);
  const metadata = await googleRequest<{ sheets?: SheetProperties[] }>(
    `${spreadsheetUrl()}?fields=sheets(properties(sheetId,title,gridProperties(rowCount,columnCount)))`
  );
  const match = (metadata.sheets ?? []).find(
    (item) => item.properties?.sheetId === expected.gid
  );
  if (
    !match?.properties ||
    match.properties.title?.trim() !== expected.title ||
    !Number.isSafeInteger(match.properties.gridProperties?.rowCount) ||
    !Number.isSafeInteger(match.properties.gridProperties?.columnCount)
  ) {
    throw new Error(`SLA test tab configuration mismatch: ${expected.title}.`);
  }
  return {
    title: match.properties.title,
    rowCount: match.properties.gridProperties!.rowCount!,
    columnCount: match.properties.gridProperties!.columnCount!,
  };
}

/** Reads only headers and a non-sensitive row count; row values are never returned. */
export async function readSlaTestTabSummary(tab: TabKey): Promise<{
  title: string;
  gid: number;
  headers: string[];
  rowCount: number;
}> {
  const resolved = await resolveTab(tab);
  const title = quoteTitle(resolved.title);
  const [headerResult, firstColumnResult] = await Promise.all([
    googleRequest<{ values?: unknown[][] }>(
      `${spreadsheetUrl()}/values/${encodeURIComponent(`${title}!1:1`)}`
    ),
    googleRequest<{ values?: unknown[][] }>(
      `${spreadsheetUrl()}/values/${encodeURIComponent(`${title}!A:A`)}`
    ),
  ]);
  const headers = (headerResult.values?.[0] ?? []).map((value) =>
    String(value ?? "").trim()
  );
  const firstColumn = firstColumnResult.values ?? [];
  return {
    title: resolved.title,
    gid: getSlaTestTab(tab).gid,
    headers,
    rowCount: Math.max(0, firstColumn.length - (headers.length ? 1 : 0)),
  };
}

/**
 * Controlled round-trip probe. It uses the bottom-right grid cell only when
 * that cell is blank, verifies the value, then clears that exact cell.
 * Every mutation is guarded immediately before its Google Sheets API call.
 */
export async function runSlaTestSheetRoundTrip(tab: TabKey): Promise<{
  tab: string;
  cell: string;
  writeVerified: boolean;
  cleanupVerified: boolean;
}> {
  const resolved = await resolveTab(tab);
  const cell = `${columnName(resolved.columnCount - 1)}${resolved.rowCount}`;
  const range = `${quoteTitle(resolved.title)}!${cell}`;
  const readUrl = `${spreadsheetUrl()}/values/${encodeURIComponent(range)}`;
  const before = await googleRequest<{ values?: unknown[][] }>(readUrl);
  const existing = before.values?.[0]?.[0];
  if (existing !== undefined && existing !== "") {
    throw new Error("SLA test probe cell is not empty; refusing to overwrite it.");
  }

  const probe = `SLA_PHASE1_PROBE_${Date.now()}`;
  let writeVerified = false;
  let cleanupVerified = false;
  let writeAttempted = false;
  try {
    writeAttempted = true;
    assertSlaTestWriteTarget(SLA_TEST_SHEET.spreadsheetId);
    await googleRequest(spreadsheetUrl("/values/" + encodeURIComponent(range) + "?valueInputOption=RAW"), {
      method: "PUT",
      body: JSON.stringify({ range, majorDimension: "ROWS", values: [[probe]] }),
    });
    const after = await googleRequest<{ values?: unknown[][] }>(readUrl);
    writeVerified = after.values?.[0]?.[0] === probe;
    if (!writeVerified) throw new Error("SLA test probe read-back did not match.");
  } finally {
    if (writeAttempted) {
      assertSlaTestWriteTarget(SLA_TEST_SHEET.spreadsheetId);
      await googleRequest(spreadsheetUrl("/values/" + encodeURIComponent(range) + ":clear"), {
        method: "POST",
        body: JSON.stringify({}),
      });
      const restored = await googleRequest<{ values?: unknown[][] }>(readUrl);
      const restoredValue = restored.values?.[0]?.[0];
      cleanupVerified = restoredValue === undefined || restoredValue === "";
      if (!cleanupVerified) throw new Error("SLA test probe cleanup could not be verified.");
    }
  }

  return { tab: resolved.title, cell, writeVerified, cleanupVerified };
}
