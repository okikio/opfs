/** Bound the native QCOW2 producer's complete process group and retained diagnostics. */
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { parseArgs } from "node:util";
import { check, json } from "../acquire.ts";
import { group } from "../group.ts";
const { values } = parseArgs({
  options: { producer: { type: "string" }, output: { type: "string" }, receipts: { type: "string" } },
});
check(
  values.producer && values.output && values.receipts && values.producer.endsWith(".ts"),
  "Usage: producer-run.ts --producer create.ts --output FRESH_JSON --receipts FRESH_DIRECTORY",
);
check(!existsSync(values.output), "Existing producer output refused.");
mkdirSync(dirname(resolve(values.receipts)), { recursive: true });
mkdirSync(values.receipts, { mode: 0o700 });
const result = await group({
  command: process.execPath,
  args: [resolve(values.producer), "--output", resolve(values.output)],
  log: join(values.receipts, "production.log"),
  seconds: 210,
  bytes: 4 * 1024 * 1024,
});
json(values.receipts, "production-run.json", {
  ...result,
  producer: resolve(values.producer),
  output: resolve(values.output),
  deadlineSeconds: 210,
  maxLogBytes: 4 * 1024 * 1024,
  scope: "New TypeScript recipe, independent native QEMU; historical Python output unchanged.",
});
check(
  result.exit === 0 && result.reason === null && result.cleanupFaults.length === 0,
  "QCOW2 producer failed; inspect retained receipt and log.",
);
