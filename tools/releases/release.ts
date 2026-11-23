/**
 * Plan, version and publish releases.
 *
 * `node tools/releases/release.ts --operation <plan|version|publish|verify> [--target npm|jsr|both]`
 *
 * Sampo owns release intent: each change adds a Markdown changeset under `.sampo/changesets/` (run
 * `node_modules/.bin/sampo add`). The operations are:
 *
 * - `plan` previews the next version and changelog without writing anything. Pull requests run it.
 * - `version` consumes the changesets into `package.json` and `CHANGELOG.md`, then copies the version into
 *   `deno.json`. The Release workflow commits the result to a `release/versions` pull request.
 * - `publish` publishes the current revision to one registry. npm receives the tarball that `tools/npm/pack.ts`
 *   builds at the release version, after `tests/package/verify.ts` checks it from a clean consumer; JSR
 *   receives the source. A registry that already has this
 *   version is skipped, so a partial failure can be retried at the same revision.
 * - `verify` installs the published version from the public registry in a fresh consumer.
 *
 * Publication refuses pending changesets: the version must already be prepared and merged.
 *
 * @module
 */
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { syncVersion } from "./versions.ts";
import { spawn } from "../workspace/spawn.ts";

const root = fileURLToPath(new URL("../../", import.meta.url));

/** True when `npm view` finds this exact version on the public registry. */
function isPublished(name: string, version: string): boolean {
  const result = spawnSync("npm", ["view", `${name}@${version}`, "version", "--registry=https://registry.npmjs.org/"], {
    cwd: root,
    encoding: "utf8",
  });
  return result.status === 0 && result.stdout.trim() === version;
}

/** True when `.sampo/changesets/` holds at least one changeset that Sampo has not released yet. */
const hasChangesets = () =>
  existsSync(`${root}/.sampo/changesets`) &&
  readdirSync(`${root}/.sampo/changesets`).some((name) => name.endsWith(".md"));

/** Sampo from the locked npm dev dependencies, so local and CI releases use one version. */
const sampo = `${root}/node_modules/.bin/sampo`;

if (import.meta.main) {
  const { values } = parseArgs({
    options: { operation: { type: "string", default: "plan" }, target: { type: "string", default: "both" } },
  });
  const targets = values.target === "both" ? ["npm", "jsr"] : [values.target];
  if (!targets.every((target) => target === "npm" || target === "jsr")) {
    throw new TypeError("--target is npm, jsr or both.");
  }
  switch (values.operation) {
    case "plan":
      syncVersion(root);
      if (!hasChangesets()) console.log("No pending changesets. The version is unchanged.");
      // Stacked pull requests target the branch below them; every stack lands on main.
      else spawn(sampo, ["release", "--dry-run"], { env: { SAMPO_RELEASE_BRANCH: "main" } });
      break;
    case "version":
      if (!hasChangesets()) {
        console.log("No pending changesets.");
        break;
      }
      spawn(sampo, ["release"]);
      syncVersion(root, { write: true });
      break;
    case "publish": {
      if (hasChangesets()) {
        throw new Error("Prepare and merge the release version before publishing pending changesets.");
      }
      const version = syncVersion(root);
      for (const target of targets) {
        if (target === "npm") {
          if (isPublished("@okikio/opfs", version)) {
            console.log(`@okikio/opfs@${version} is already on npm.`);
            continue;
          }
          // Build at the real version, check that exact tarball from a clean consumer, then publish it.
          const built = spawnSync("deno", ["run", "--frozen", "-A", "tools/npm/pack.ts"], {
            cwd: root,
            encoding: "utf8",
            stdio: ["ignore", "pipe", "inherit"],
          });
          const tarball = built.stdout.trim().split("\n").at(-1);
          if (built.status !== 0 || !tarball?.endsWith(".tgz")) {
            throw new Error("tools/npm/pack.ts did not build a tarball.");
          }
          spawn("node", ["tests/package/verify.ts", tarball]);
          spawn("npm", ["publish", tarball, "--provenance", "--access", "public"]);
        } else {
          spawn("deno", ["publish", "--frozen"]);
        }
      }
      break;
    }
    case "verify":
      for (const target of targets) spawn("deno", ["run", "-A", "tools/releases/consumer.ts", target]);
      break;
    default:
      throw new TypeError("--operation is plan, version, publish or verify.");
  }
}
