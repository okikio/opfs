/**
 * Test OPFS against real installations of the ecosystems it bridges: unstorage, db0, Drizzle and RxDB.
 *
 * The consumers are installed at pinned versions into a temporary directory, outside the repository's own
 * dependency graph, so a passing run proves the adapters work with what an application would install rather
 * than with the development dependencies. `tests/ecosystem/live.ts` then loads them from
 * `OPFS_ECOSYSTEM_ROOT`. The directory is removed afterwards, even when the test fails.
 *
 * @module
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "../workspace/spawn.ts";

/** The consumer versions under test. Raise them together with the adapters that support them. */
export const consumers = ["unstorage@1.17.5", "db0@0.4.1", "drizzle-orm@0.45.2", "rxdb@17.6.0"];

if (import.meta.main) {
  const prefix = mkdtempSync(join(tmpdir(), "opfs-ecosystems-"));
  try {
    // Lifecycle scripts never run: the consumers are data for the test, not trusted build steps.
    spawn("npm", [
      "install",
      "--package-lock=false",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--prefix",
      prefix,
      "--cache",
      join(prefix, "cache"),
      ...consumers,
    ]);
    spawn("node", ["--test", "tests/ecosystem/live.ts"], { env: { OPFS_ECOSYSTEM_ROOT: prefix } });
  } finally {
    rmSync(prefix, { recursive: true, force: true });
  }
}
