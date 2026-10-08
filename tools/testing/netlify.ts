/**
 * Run the Netlify Blobs qualification: the frozen SDK closure against the bundled candidate client.
 *
 * The test compares two independent implementations byte for byte, so it needs three inputs the ordinary
 * runner does not prepare:
 *
 * 1. the inert, test-only Netlify SDK closure, acquired at its pinned version into `.tmp/netlify-inert`;
 * 2. the candidate client, bundled for the browser platform into `.tmp/netlify-candidate.ts`;
 * 3. the SHA-256 of both, which the test checks before it loads either, so a stale file cannot pass.
 *
 * Bundling uses a larger V8 heap than the comparison itself; each step runs in its own process with its own
 * limit. Then the `netlify` test family runs on Deno with those paths in its environment.
 *
 * @module
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const artifacts = ".tmp/netlify-inert";
const candidate = ".tmp/netlify-candidate.ts";

/** Run one step and stop on failure, so a later step never sees a partial input. */
function step(program: string, args: readonly string[], env: NodeJS.ProcessEnv = {}): void {
  const result = spawnSync(program, args, { cwd: root, stdio: "inherit", env: { ...process.env, ...env } });
  if (result.status !== 0) throw new Error(`${program} ${args.join(" ")} exited with ${result.status}.`);
}

const sha256 = (path: string) => createHash("sha256").update(readFileSync(`${root}/${path}`)).digest("hex");

step("node", ["tests/fixtures/netlify/acquire.ts", "--output", artifacts]);
step("deno", ["bundle", "--frozen", "--platform=browser", "src/netlify.ts", "--output", candidate], {
  DENO_V8_FLAGS: "--max-old-space-size=1536",
});
step("node", ["tools/testing/run.ts", "deno", "--family", "netlify", ...process.argv.slice(2)], {
  DENO_V8_FLAGS: "--max-old-space-size=256",
  OPFS_NETLIFY_ARTIFACTS: artifacts,
  OPFS_NETLIFY_EXECUTION_REVIEWED: "11.1.7-test-only",
  OPFS_NETLIFY_CANDIDATE: candidate,
  OPFS_NETLIFY_CLOSURE_SHA256: sha256(`${artifacts}/closure.json`),
  OPFS_NETLIFY_CANDIDATE_SHA256: sha256(candidate),
});
