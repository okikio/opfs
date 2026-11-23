import { describe, it } from "node:test";
import { expect } from "@std/expect";
import { classify, select, shard } from "./discover.ts";

describe("test discovery", () => {
  it("classifies by file name so a new test needs no manifest edit", () => {
    const cases: [string, string][] = [
      ["tests/xz.test.ts", "portable"],
      ["tests/gcs-provider.test.ts", "provider"],
      ["tests/provider.test.ts", "provider"],
      ["tests/netlify-sdk.test.ts", "netlify"],
      ["tests/zip-process.test.ts", "interop"],
      ["tests/process.test.ts", "process"],
      ["tests/fixtures/kafka/metadata.test.ts", "deno"],
    ];
    for (const [path, family] of cases) expect(classify(path).family).toBe(family);
  });
  it("gives every classified test a reason a reader can check", () => {
    expect(classify("tests/gcs-provider.test.ts").reason).toMatch(/Testcontainers/);
  });
  it("leaves a platform-bound test out only on other operating systems", () => {
    const files = [classify("tests/fixtures/arrow/runner.test.ts"), classify("tests/node.test.ts")];
    expect(files[0]!.platforms).toEqual(["linux"]);
    expect(files[0]!.reason).toMatch(/\/proc/);
    expect(select(files, "node", undefined, "linux").map((file) => file.path)).toHaveLength(2);
    expect(select(files, "node", undefined, "darwin").map((file) => file.path)).toEqual(["tests/node.test.ts"]);
    expect(select(files, "node").map((file) => file.path)).toHaveLength(2);
  });
  it("splits files into disjoint shards that together cover every file", () => {
    const files = Array.from({ length: 11 }, (_, index) => ({ path: `tests/${index}.test.ts` }));
    const parts = [1, 2, 3].map((index) => shard(files, index, 3).map((file) => file.path));
    expect(parts.flat().sort()).toEqual(files.map((file) => file.path).sort());
    expect(new Set(parts.flat()).size).toBe(files.length);
  });
});
