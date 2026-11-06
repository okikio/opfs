/** Launch a fresh, explicitly owned age fixture container with retained bounded evidence. */
import { parseArgs } from "node:util";
import { check } from "../../acquire.ts";
import { launch } from "../../launch.ts";
const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { stage: { type: "string" }, output: { type: "string" }, deadline: { type: "string", default: "180" } },
});
check(
  positionals.length === 1 && values.output && values.deadline === "180",
  "Usage: age-run.ts opfs-age-NAME --stage cli|vectors|producer --output FRESH_PATH [--deadline 180]",
);
const stage = values.stage;
check(stage === "cli" || stage === "vectors" || stage === "producer", "Expected explicit age stage.");
await launch({ container: positionals[0]!, family: "age", stage, output: values.output });
