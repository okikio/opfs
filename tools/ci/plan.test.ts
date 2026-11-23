import { describe, it } from "node:test";
import { expect } from "@std/expect";
import { lanes, plan } from "./plan.ts";

const families = new Set(["provider", "interop", "netlify"]);

describe("CI lane plan", () => {
  it("runs only the source checks when a change is prose or planning", () => {
    const result = plan(["docs/xz.md", "planning/storage/GROUPS.md"], families);
    expect(Object.entries(result).filter(([, run]) => run).map(([lane]) => lane)).toEqual(["source"]);
  });
  it("runs every lane for a code change when every test family exists", () => {
    const result = plan(["src/archive/xz.ts"], families);
    expect(lanes.every((lane) => result[lane])).toBe(true);
  });
  it("never selects a lane whose test family does not exist at this revision", () => {
    const result = plan(["src/archive/xz.ts"], new Set());
    expect([result.providers, result.interop, result.netlify]).toEqual([false, false, false]);
    expect(result.runtimes).toBe(true);
  });
  it("runs every code lane for a full plan even with no changed paths", () => {
    const result = plan([], families, { full: true });
    expect(lanes.every((lane) => result[lane])).toBe(true);
  });
});
