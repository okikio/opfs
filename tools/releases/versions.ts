/**
 * Keep the package's two manifests on one version.
 *
 * `package.json` owns the version: Sampo writes it from the pending changesets. `deno.json` is the JSR
 * manifest and must carry the same name and version, or JSR and npm would publish different releases from
 * one revision. `check` (the default) fails on any difference; `--write` copies the version into `deno.json`,
 * changing only that one value so the file's formatting stays as authored.
 *
 * @module
 */
import { readFileSync, writeFileSync } from "node:fs";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));

/** Compare the manifests; with `write`, update `deno.json`. Returns the version. */
export function versions(base = root, write = false): string {
  const npm = JSON.parse(readFileSync(`${base}/package.json`, "utf8")) as { name: string; version: string };
  const text = readFileSync(`${base}/deno.json`, "utf8");
  const deno = JSON.parse(text) as { name: string; version: string };
  if (npm.name !== deno.name) throw new Error(`package.json names ${npm.name}, but deno.json names ${deno.name}.`);
  if (npm.version !== deno.version) {
    if (!write) {
      throw new Error(
        `package.json is ${npm.version}, but deno.json is ${deno.version}. Run the release version step.`,
      );
    }
    const updated = text.replace(/("version"\s*:\s*)"[^"]*"/u, `$1${JSON.stringify(npm.version)}`);
    writeFileSync(`${base}/deno.json`, updated);
  }
  return npm.version;
}

if (import.meta.main) {
  const version = versions(root, process.argv.includes("--write"));
  console.log(`package.json and deno.json agree on ${version}.`);
}
