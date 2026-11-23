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
import process from "node:process";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { versions } from "./versions.ts";

const root = fileURLToPath(new URL("../../", import.meta.url));

/** Run a command in the repository and stop on failure. */
function run(program: string, args: readonly string[], env: NodeJS.ProcessEnv = {}): void {
  console.log(`==> ${program} ${args.join(" ")}`);
  const result = spawnSync(program, args, { cwd: root, stdio: "inherit", env: { ...process.env, ...env } });
  if (result.status !== 0) throw new Error(`${program} exited with ${result.status}.`);
}

/** True when `npm view` finds this exact version on the public registry. */
function published(name: string, version: string): boolean {
  const result = spawnSync("npm", ["view", `${name}@${version}`, "version", "--registry=https://registry.npmjs.org/"], {
    cwd: root,
    encoding: "utf8",
  });
  return result.status === 0 && result.stdout.trim() === version;
}

const pending = () =>
  existsSync(`${root}/.sampo/changesets`) &&
  readdirSync(`${root}/.sampo/changesets`).some((name) => name.endsWith(".md"));

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
      versions(root);
      if (!pending()) console.log("No pending changesets. The version is unchanged.");
      // Stacked pull requests target the branch below them; every stack lands on main.
      else run(sampo, ["release", "--dry-run"], { SAMPO_RELEASE_BRANCH: "main" });
      break;
    case "version":
      if (!pending()) {
        console.log("No pending changesets.");
        break;
      }
      run(sampo, ["release"]);
      versions(root, true);
      break;
    case "publish": {
      if (pending()) throw new Error("Prepare and merge the release version before publishing pending changesets.");
      const version = versions(root);
      for (const target of targets) {
        if (target === "npm") {
          if (published("@okikio/opfs", version)) {
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
          run("node", ["tests/package/verify.ts", tarball]);
          run("npm", ["publish", tarball, "--provenance", "--access", "public"]);
        } else {
          run("deno", ["publish", "--frozen"]);
        }
      }
      break;
    }
    case "verify":
      for (const target of targets) run("deno", ["run", "-A", "tools/releases/consumer.ts", target]);
      break;
    default:
      throw new TypeError("--operation is plan, version, publish or verify.");
  }
}
