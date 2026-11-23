import { describe, it } from "node:test";
import { expect } from "@std/expect";
import * as suite from "./suite.ts";

describe("runtime test commands", () => {
  it("runs Deno without type checking and with loopback-only network", () => {
    const command = suite.createCommand("deno", ["tests/xz.test.ts"], new Set(["portable"]));
    expect(command).toContain("--no-check");
    expect(command).toContain("--allow-net=127.0.0.1,localhost,[::1]");
    expect(command.at(-1)).toBe("tests/xz.test.ts");
  });
  it("adds Deno KV only when a kv test is selected", () => {
    expect(suite.createCommand("deno", ["tests/deno-kv.test.ts"], new Set(["kv"]))).toContain("--unstable-kv");
    expect(suite.createCommand("deno", ["tests/xz.test.ts"], new Set(["portable"]))).not.toContain("--unstable-kv");
  });
  it("refuses stress and coverage modes outside Deno", () => {
    expect(() => suite.createCommand("node", [], new Set(), { stress: true })).toThrow(/need Deno/);
  });
});
