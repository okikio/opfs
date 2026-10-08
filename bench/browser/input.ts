import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { openInputGuard } from "../input.ts";

/**
 * Playwright awaits this setup before tests and its returned teardown after
 * work. Source admission is separate from the JSON reporter's test status: an
 * unchanged receipt cannot promote failed or missing workload samples to pass.
 * A failed input comparison rejects teardown and leaves an invalid receipt.
 */
export default async function setup(): Promise<() => Promise<void>> {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const directory = join(root, ".tmp/reports/browser-bench");
  await mkdir(directory, { recursive: true });
  return await openInputGuard(async (receipt) => {
    await writeFile(join(directory, "inputs.json"), JSON.stringify(receipt, null, 2) + "\n");
  }, root);
}
