/**
 * The Quality workflow's final job: fail unless every selected lane succeeded.
 *
 * `RESULTS='<needs JSON>' node tools/ci/result.ts`
 *
 * Branch protection requires this one job instead of every lane, because which lanes run depends on the change.
 * It reads the `needs` context: the plan's per-lane booleans and each lane job's result. A selected lane must
 * report `success`; an unselected one may also be `skipped`. A missing or unreadable plan fails, so a broken
 * planner can never turn into a passing required check. It needs no installed dependencies.
 *
 * @module
 */
import process from "node:process";
import { lanes } from "./plan.ts";

/** GitHub aggregates every matrix child into one job result. */
interface JobResultType {
  /** Only success proves that selected work completed. */
  readonly result: string;
  /** The planner exposes explicit booleans for every owned lane. */
  readonly outputs?: Readonly<Record<string, string>>;
}

/**
 * Throw unless the plan succeeded and every lane it selected succeeded.
 *
 * In a native pull request stack, lower layers skip this job in YAML; they cannot supply a passing result for a
 * failed top layer. Missing or skipped selected work fails.
 */
export function check(jobs: Readonly<Record<string, JobResultType>>): void {
  if (jobs.plan?.result !== "success" || jobs.plan.outputs?.selected !== "true") {
    throw new Error("A successful selected plan is required.");
  }
  for (const lane of lanes) {
    const selected = jobs.plan.outputs[lane];
    if (selected !== "true" && selected !== "false") throw new Error(`Missing ${lane} selection.`);
    const result = jobs[lane]?.result;
    if (selected === "true" ? result !== "success" : !["success", "skipped"].includes(result ?? "")) {
      throw new Error(
        `${lane}: expected ${selected === "true" ? "success" : "success or skipped"}, received ${result}.`,
      );
    }
  }
}

if (import.meta.main) {
  check(JSON.parse(process.env.RESULTS ?? "{}"));
}
