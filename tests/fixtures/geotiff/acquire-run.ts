/** Carry one finite diagnostic/time allowance across signed download and offline installation. */
import { mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { check, integer, json, record } from "../acquire.ts";
import { group } from "../group.ts";
const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { script: { type: "string" }, admission: { type: "string" }, receipts: { type: "string" } },
});
check(
  values.script && values.admission && values.receipts && positionals.length === 1 &&
    ["download", "install"].includes(positionals[0]!),
  "Usage: acquire-run.ts download|install --script acquire.sh --admission apt.ts --receipts OWNED_DIRECTORY",
);
const stage = positionals[0]!, root = resolve(values.receipts);
let priorSeconds = 0, priorBytes = 0;
if (stage === "download") {
  mkdirSync(dirname(root), { recursive: true });
  mkdirSync(root, { mode: 0o700 });
} else {
  const path = join(root, "acquisition-download.json");
  check(statSync(path).size <= 65536, "Previous stage receipt ceiling.");
  const previous = record(JSON.parse(readFileSync(path, "utf8")));
  check(
    previous.exit === 0 && previous.reason === null && Array.isArray(previous.cleanupFaults) &&
      previous.cleanupFaults.length === 0,
    "Download stage did not finish successfully.",
  );
  check(
    typeof previous.totalElapsedSeconds === "number" && Number.isFinite(previous.totalElapsedSeconds) &&
      previous.totalElapsedSeconds >= 0,
    "Previous stage elapsed extent.",
  );
  priorSeconds = previous.totalElapsedSeconds;
  priorBytes = integer(previous.totalLogBytes, 4 * 1024 * 1024);
}
check(priorSeconds < 180 && priorBytes < 4 * 1024 * 1024, "Combined acquisition allowance exhausted.");
// Debian dash applies both hard and soft RLIMIT_FSIZE in 512-byte blocks.
const result = await group({
  command: "/bin/dash",
  args: [
    "-c",
    'ulimit -f 131072 || exit; exec "$@"',
    "opfs-acquisition",
    "/bin/dash",
    resolve(values.script),
    stage,
    root,
    resolve(values.admission),
  ],
  log: join(root, "acquisition-" + stage + ".log"),
  seconds: 180 - priorSeconds,
  bytes: 4 * 1024 * 1024 - priorBytes,
});
json(root, "acquisition-" + stage + ".json", {
  ...result,
  script: resolve(values.script),
  admission: resolve(values.admission),
  stage,
  maxLogBytes: 4 * 1024 * 1024 - priorBytes,
  deadlineSeconds: 180,
  totalElapsedSeconds: priorSeconds + result.elapsedSeconds,
  totalLogBytes: priorBytes + result.logBytes,
});
check(
  result.exit === 0 && result.reason === null && result.cleanupFaults.length === 0,
  "Acquisition failed; inspect retained stage log and receipt.",
);
