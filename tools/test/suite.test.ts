import { describe, it } from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect } from "@std/expect";
import * as suite from "./suite.ts";

/** Exercise the real suite entrypoint without starting the selected test programs. */
function listing(runtime: string, ...selectors: string[]) {
  return spawnSync("node", [fileURLToPath(new URL("./suite.ts", import.meta.url)), runtime, ...selectors, "--list"], {
    cwd: fileURLToPath(new URL("../../", import.meta.url)),
    encoding: "utf8",
    timeout: 10_000,
  });
}

describe("explicit test selection", () => {
  for (const family of ["constructor", "toString", "__proto__", "missing"]) {
    it(`rejects unknown family ${family} at the actual entrypoint`, () => {
      const result = listing("node", "--family", family);
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(`Unknown test family ${family}.`);
      expect(result.stdout).toBe("");
    });
  }
  for (const [runtime, family] of [["node", "kv"], ["deno", "node"], ["bun", "process"]] as const) {
    it(`rejects ${family} on ${runtime} instead of reporting an empty success`, () => {
      const result = listing(runtime, "--family", family);
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(`Test family ${family} does not run on ${runtime}.`);
    });
  }
  it("rejects an unsupported family even when another named family has tests", () => {
    const result = listing("node", "--family", "portable", "--family", "kv", "tools/test/suite.test.ts");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Test family kv does not run on node.");
    expect(result.stdout).toBe("");
  });
  it("lists an exact authored file through its supported family", () => {
    const result = listing("node", "--family", "portable", "tools/test/suite.test.ts");
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("portable  tools/test/suite.test.ts");
  });
  it("rejects an unmatched file before sharding", () => {
    const result = listing("node", "tools/test/no-such-test.test.ts", "--shard", "2/2");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("No node test matches tools/test/no-such-test.test.ts.");
  });
  it("allows an empty explicit shard of a nonempty selection", () => {
    const result = listing("node", "tools/test/suite.test.ts", "--shard", "2/2");
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("");
  });
});

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
