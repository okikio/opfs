import { describe, it } from "node:test";
import { expect } from "@std/expect";
import * as suite from "./suite.ts";

describe("runtime test commands", () => {
  it("runs Deno without type checking and with loopback-only network", () => {
    const command = suite.createCommand("deno", ["tests/xz.test.ts"], new Set(["portable"]));
    expect(command).toContain("--no-check");
    expect(command).toContain("--allow-net=127.0.0.1,localhost,[::1]");
    expect(command.some((flag) => flag.startsWith("--allow-ffi"))).toBe(false);
    expect(command).not.toContain("--allow-all");
    expect(command.at(-1)).toBe("tests/xz.test.ts");
  });
  it("allows installed native libraries when the type-selection test is selected", () => {
    const files = ["tests/xz.test.ts", "tools/check/types.test.ts"];
    const command = suite.createCommand("deno", files, new Set(["portable"]));
    expect(command.filter((flag) => flag.startsWith("--allow-ffi"))).toEqual(["--allow-ffi=node_modules"]);
    expect(command).not.toContain("--allow-all");
    expect(command).toContain("--allow-net=127.0.0.1,localhost,[::1]");
    expect(command.slice(-files.length)).toEqual(files);
  });
  it("keeps native library access disabled for other tooling tests", () => {
    const files = ["tools/test/suite.test.ts", "tools/test/discover.test.ts"];
    const command = suite.createCommand("deno", files, new Set(["portable"]));
    expect(command.some((flag) => flag.startsWith("--allow-ffi"))).toBe(false);
    expect(command).not.toContain("--allow-all");
  });
  for (
    const { name, mode, flags } of [
      { name: "stress", mode: { stress: true }, flags: ["--shuffle=424242", "--repeats=2"] },
      { name: "coverage", mode: { coverage: true }, flags: ["--clean", "--coverage=.tmp/reports/coverage"] },
    ]
  ) {
    it(`preserves ${name} mode with scoped native parser access`, () => {
      const command = suite.createCommand("deno", ["tools/check/types.test.ts"], new Set(["portable"]), mode);
      expect(command.filter((flag) => flag.startsWith("--allow-ffi"))).toEqual(["--allow-ffi=node_modules"]);
      expect(command).toContain("--allow-net=127.0.0.1,localhost,[::1]");
      for (const flag of flags) expect(command).toContain(flag);
      expect(command.at(-1)).toBe("tools/check/types.test.ts");
    });
  }
  it("keeps the Netlify permission contract without a redundant native grant", () => {
    for (
      const files of [["tests/netlify/isolation.test.ts"], [
        "tests/netlify/isolation.test.ts",
        "tools/check/types.test.ts",
      ]]
    ) {
      const command = suite.createCommand("deno", files, new Set(["netlify", "portable"]));
      expect(command.filter((flag) => flag.startsWith("--allow-"))).toEqual(["--allow-all"]);
    }
  });
  it("keeps Node commands unchanged for selections that include the parser", () => {
    const files = ["tests/xz.test.ts", "tools/check/types.test.ts"];
    expect(suite.createCommand("node", files, new Set(["portable"]))).toEqual([
      "node",
      "--test",
      "--test-concurrency=4",
      ...files,
    ]);
  });
  it("keeps Bun commands unchanged for selections that include the parser", () => {
    expect(suite.createCommand("bun", ["tests/xz.test.ts", "tools/check/types.test.ts"], new Set(["portable"])))
      .toEqual(["bun", "test", "--timeout", "30000", "./tests/xz.test.ts", "./tools/check/types.test.ts"]);
  });
  it("adds Deno KV only when a kv test is selected", () => {
    expect(suite.createCommand("deno", ["tests/deno-kv/mod.test.ts"], new Set(["kv"]))).toContain("--unstable-kv");
    expect(suite.createCommand("deno", ["tests/xz.test.ts"], new Set(["portable"]))).not.toContain("--unstable-kv");
  });
  it("refuses stress and coverage modes outside Deno", () => {
    expect(() => suite.createCommand("node", [], new Set(), { stress: true })).toThrow(/need Deno/);
    expect(() => suite.createCommand("node", [], new Set(), { coverage: true })).toThrow(/need Deno/);
    expect(() => suite.createCommand("bun", [], new Set(), { stress: true })).toThrow(/need Deno/);
    expect(() => suite.createCommand("bun", [], new Set(), { coverage: true })).toThrow(/need Deno/);
  });
});
