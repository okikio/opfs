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
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { spawn } from "../spawn.ts";

const root = fileURLToPath(new URL("../../", import.meta.url));
const artifacts = ".tmp/netlify-inert";
const candidate = ".tmp/netlify-candidate.ts";

const sha256 = (path: string) => createHash("sha256").update(readFileSync(`${root}/${path}`)).digest("hex");

spawn("node", ["tests/fixtures/netlify/acquire.ts", "--output", artifacts]);
spawn("deno", ["bundle", "--frozen", "--platform=browser", "src/netlify.ts", "--output", candidate], {
  env: { DENO_V8_FLAGS: "--max-old-space-size=1536" },
});
spawn("node", ["tools/test/suite.ts", "deno", "--family", "netlify", ...process.argv.slice(2)], {
  env: {
    DENO_V8_FLAGS: "--max-old-space-size=256",
    OPFS_NETLIFY_ARTIFACTS: artifacts,
    OPFS_NETLIFY_EXECUTION_REVIEWED: "11.1.7-test-only",
    OPFS_NETLIFY_CANDIDATE: candidate,
    OPFS_NETLIFY_CLOSURE_SHA256: sha256(`${artifacts}/closure.json`),
    OPFS_NETLIFY_CANDIDATE_SHA256: sha256(candidate),
  },
});
