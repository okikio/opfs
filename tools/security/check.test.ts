/** Advisory exceptions must be complete and current, and deno audit ids must be read exactly. */
import { it } from "node:test";
import { expect } from "@std/expect";
import { admit, advisories, quoteDates } from "./check.ts";

const today = "2026-11-23";

it("admits a complete, current exception", () => {
  const entry = { id: "GHSA-aaaa-bbbb-cccc", reason: "Test-only path.", ignoreUntil: "2027-01-01" };
  expect(admit([entry], today)).toEqual([{
    id: "GHSA-aaaa-bbbb-cccc",
    reason: "Test-only path.",
    until: "2027-01-01",
  }]);
});

it("admits an exception on its last day", () => {
  expect(admit([{ id: "GHSA-aaaa-bbbb-cccc", reason: "r", ignoreUntil: today }], today)).toHaveLength(1);
});

it("rejects expired, unexplained and undated exceptions, naming each problem", () => {
  const entries = [
    { id: "GHSA-old0-0000-0000", reason: "r", ignoreUntil: "2026-11-22" },
    { id: "GHSA-none-0000-0000", reason: "  ", ignoreUntil: "2027-01-01" },
    { id: "GHSA-date-0000-0000", reason: "r" },
    { reason: "r", ignoreUntil: "2027-01-01" },
  ];
  expect(() => admit(entries, today)).toThrow(/GHSA-old0-0000-0000: expired on 2026-11-22/);
  expect(() => admit(entries, today)).toThrow(/GHSA-none-0000-0000: missing reason/);
  expect(() => admit(entries, today)).toThrow(/GHSA-date-0000-0000: ignoreUntil must be a YYYY-MM-DD date/);
  expect(() => admit(entries, today)).toThrow(/entry 4: missing id/);
});

it("reads advisory ids from a colored deno audit report once each", () => {
  const report = [
    "\u001b[0m╭ glob: AbortSignal cancellation bypass",
    "╰ \u001b[38;5;245mInfo:\u001b[0m       https://github.com/advisories/GHSA-3g3m-2fjr-6pw4",
    "╰ Info: https://github.com/advisories/GHSA-g3hv-75wg-m249",
    "╰ Info: https://github.com/advisories/GHSA-3g3m-2fjr-6pw4",
    "Found 3 vulnerabilities",
  ].join("\n");
  expect(advisories(report)).toEqual(["GHSA-3g3m-2fjr-6pw4", "GHSA-g3hv-75wg-m249"]);
  expect(advisories("error: could not reach the registry")).toEqual([]);
});

it("quotes only ignoreUntil local dates", () => {
  const toml = 'id = "2027-01-01"\nignoreUntil = 2027-02-21\n  ignoreUntil = 2027-03-01 # note\n';
  expect(quoteDates(toml)).toBe('id = "2027-01-01"\nignoreUntil = "2027-02-21"\n  ignoreUntil = "2027-03-01" # note\n');
});
