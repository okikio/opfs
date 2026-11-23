/** Lower stack layers and failed combined candidates must never become passing required checks. */
import { it } from "node:test";
import { expect } from "@std/expect";
import * as result from "./result.ts";

/** A documentation-only plan deliberately leaves every resource lane unselected. */
function documentation() {
  const lanes = [
    "source",
    "runtimes",
    "platforms",
    "browser",
    "providers",
    "interop",
    "netlify",
    "package",
    "bench",
    "stress",
  ];
  return {
    plan: {
      result: "success",
      outputs: { selected: "true", ...Object.fromEntries(lanes.map((lane) => [lane, String(lane === "source")])) },
    },
    ...Object.fromEntries(lanes.map((lane) => [lane, { result: lane === "source" ? "success" : "skipped" }])),
  };
}

it("accepts actual selected success and deliberate unselected skips", () => {
  expect(() => result.check(documentation())).not.toThrow();
});

it("rejects failed, cancelled, skipped or missing selected work on the top candidate", () => {
  for (const outcome of ["failure", "cancelled", "skipped", ""]) {
    expect(() => result.check({ ...documentation(), source: { result: outcome } })).toThrow();
  }
  const missing = Object.fromEntries(Object.entries(documentation()).filter(([name]) => name !== "source"));
  expect(() => result.check(missing)).toThrow();
});

it("cannot turn a lower layer or an unsuccessful plan into top-candidate success", () => {
  const jobs = documentation();
  expect(() => result.check({ ...jobs, plan: { ...jobs.plan, outputs: { ...jobs.plan.outputs, selected: "false" } } }))
    .toThrow();
  expect(() => result.check({ ...jobs, plan: { ...jobs.plan, result: "failure" } })).toThrow();
  expect(() => result.check({ ...jobs, plan: { result: "success" } })).toThrow();
});
