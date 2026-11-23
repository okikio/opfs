import { describe, it } from "node:test";
import { expect } from "@std/expect";
import { getSteps } from "./lane.ts";

const tasks = (steps: ReturnType<typeof getSteps>) => steps.map(({ task, args }) => [task, ...args].join(" "));

describe("CI lane steps", () => {
  it("runs the source checks with no arguments", () => {
    const steps = getSteps("source");
    expect(steps.every(({ task, args }) => task.startsWith("check:") && args.length === 0)).toBe(true);
    expect(tasks(steps)).toContain("check:types");
  });
  it("needs a runtime for runtime lanes, and adds the tar regressions to the unsharded Deno job only", () => {
    expect(() => getSteps("runtimes")).toThrow(/--runtime/);
    expect(tasks(getSteps("runtimes", { runtime: "deno" }))).toEqual(["test:deno", "test:validation"]);
    expect(tasks(getSteps("platforms", { runtime: "deno" }))).toEqual(["test:deno"]);
    expect(tasks(getSteps("runtimes", { runtime: "node", shard: "1/2" }))).toEqual(["test:node --shard 1/2"]);
  });
  it("installs browsers before the steps that need them", () => {
    expect(tasks(getSteps("browser", { shard: "2/3" }))).toEqual(["prepare:browser", "test:browser --shard 2/3"]);
    expect(tasks(getSteps("bench", { kind: "browser" }))).toEqual([
      "prepare:browser chromium",
      "bench:browser --project chromium",
    ]);
  });
});
