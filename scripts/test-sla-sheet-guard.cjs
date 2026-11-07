const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");
const ts = require("typescript");

const sourcePath = path.join(__dirname, "../src/lib/sla/test-sheet-config.ts");
const source = fs.readFileSync(sourcePath, "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;
const loaded = new Module(sourcePath, module);
loaded.filename = sourcePath;
loaded.paths = Module._nodeModulePaths(path.dirname(sourcePath));
loaded._compile(compiled, sourcePath);

const { assertSlaTestWriteTarget, getSlaTestTab, SLA_TEST_SHEET } = loaded.exports;
const primaryId = "1gT8xUWKw-83xIYCXtYXJZU1S4M87JpapM-ROBqF_KgQ";

assert.doesNotThrow(() => assertSlaTestWriteTarget(SLA_TEST_SHEET.spreadsheetId));
assert.throws(() => assertSlaTestWriteTarget(primaryId), /Blocked SLA test write/);
assert.throws(() => assertSlaTestWriteTarget("unknown-spreadsheet"), /Blocked SLA test write/);
assert.deepEqual(getSlaTestTab("distribution"), { title: "Distribution", gid: 1488672064 });
assert.deepEqual(getSlaTestTab("matches"), { title: "Matches (T)", gid: 1821199165 });

const original = process.env.GOOGLE_SHEETS_SPREADSHEET_ID;
process.env.GOOGLE_SHEETS_SPREADSHEET_ID = primaryId;
try {
  assert.equal(SLA_TEST_SHEET.spreadsheetId, "1aWy8wMquLBR0jROfg0n9k4ONSvVu2sjPGpf-JjgeJ8M");
  assert.doesNotThrow(() => assertSlaTestWriteTarget(SLA_TEST_SHEET.spreadsheetId));
  assert.throws(() => assertSlaTestWriteTarget(process.env.GOOGLE_SHEETS_SPREADSHEET_ID), /Blocked SLA test write/);
} finally {
  if (original === undefined) delete process.env.GOOGLE_SHEETS_SPREADSHEET_ID;
  else process.env.GOOGLE_SHEETS_SPREADSHEET_ID = original;
}

console.log("SLA test-sheet isolation checks passed (5 groups).");
