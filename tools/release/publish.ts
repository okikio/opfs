/**
 * Publish the current revision to one registry: `node tools/release/publish.ts --target npm|jsr`.
 *
 * npm receives the tarball that `tools/npm/pack.ts` builds at the release version, after `tests/package/verify.ts`
 * checks that exact file from a clean consumer. JSR receives the source. A registry that already has this version
 * is skipped, so a partial failure can be retried at the same revision. Pending changesets stop publication: the
 * version must already be prepared and merged.
 *
 * @module
 */
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import * as manifest from "./manifest.ts";
import * as sampo from "./sampo.ts";
import { spawn } from "../spawn.ts";

const root = fileURLToPath(new URL("../../", import.meta.url));

/** True when `npm view` finds this exact version on the public registry. */
function isPublished(name: string, version: string): boolean {
  const result = spawnSync("npm", ["view", `${name}@${version}`, "version", "--registry=https://registry.npmjs.org/"], {
    cwd: root,
    encoding: "utf8",
  });
  return result.status === 0 && result.stdout.trim() === version;
}

/** Build the npm tarball at the release version and return its path; `pack.ts` prints it last. */
function packTarball(): string {
  const built = spawnSync("deno", ["run", "--frozen", "-A", "tools/npm/pack.ts"], {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  });
  const tarball = built.stdout.trim().split("\n").at(-1);
  if (built.status !== 0 || !tarball?.endsWith(".tgz")) throw new Error("tools/npm/pack.ts did not build a tarball.");
  return tarball;
}

const { values } = parseArgs({ options: { target: { type: "string" } } });
if (values.target !== "npm" && values.target !== "jsr") throw new TypeError("--target is npm or jsr.");
if (sampo.hasChangesets()) throw new Error("Prepare and merge the release version before publishing.");
const version = manifest.check(root);
if (values.target === "jsr") spawn("deno", ["publish", "--frozen"]);
else if (isPublished("@okikio/opfs", version)) console.log(`@okikio/opfs@${version} is already on npm.`);
else {
  const tarball = packTarball();
  spawn("node", ["tests/package/verify.ts", tarball]);
  spawn("npm", ["publish", tarball, "--provenance", "--access", "public"]);
}
