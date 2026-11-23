/** Require observed success for every selected lane without installing application dependencies. @module */
import { lanes } from "./ci.ts";

/** GitHub aggregates every matrix child into one job result. */
interface JobResultType {
  /** Only success proves that selected work completed. */
  readonly result: string;
  /** The planner exposes explicit booleans for every owned lane. */
  readonly outputs?: Readonly<Record<string, string>>;
}

/**
 * A selected stack top must finish its own combined candidate checks.
 * Lower layers skip this aggregate in YAML; they cannot supply a successful
 * aggregate for a failed top. Missing or skipped selected work fails closed.
 */
export function requireSelectedResults(jobs: Readonly<Record<string, JobResultType>>): void {
  if (jobs.plan?.result !== "success" || jobs.plan.outputs?.selected !== "true") {
    throw new Error("A successful selected plan is required.");
  }
  for (const lane of lanes) {
    const selected = jobs.plan.outputs[lane];
    if (selected !== "true" && selected !== "false") throw new Error(`Missing ${lane} selection.`);
    const job = lane;
    const result = jobs[job]?.result;
    if (selected === "true" ? result !== "success" : !["success", "skipped"].includes(result ?? "")) {
      throw new Error(
        `${lane}: expected ${selected === "true" ? "success" : "success or skipped"}, received ${result}.`,
      );
    }
  }
}

if (import.meta.main) {
  requireSelectedResults(JSON.parse(process.env.RESULTS ?? "{}"));
}
