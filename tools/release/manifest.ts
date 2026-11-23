/**
 * Keep the package's two manifests on one version.
 *
 * `package.json` owns the version: Sampo writes it from the pending changesets. `deno.json` is the JSR
 * manifest and must carry the same name and version, or JSR and npm would publish different releases from
 * one revision. `check` fails on any difference; `write` copies the version into `deno.json`, changing only
 * that one value so the file's formatting stays as authored. Run `node tools/release/manifest.ts [--write]`.
 *
 * @module
 */
import { readFileSync, writeFileSync } from "node:fs";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));

/** The two manifests' name and version fields. */
interface ManifestType {
  readonly name: string;
  readonly version: string;
}

/** Read both manifests; `deno` keeps its text so a write changes only the version value. */
function read(base: string): { npm: ManifestType; deno: ManifestType; text: string } {
  const npm = JSON.parse(readFileSync(`${base}/package.json`, "utf8")) as ManifestType;
  const text = readFileSync(`${base}/deno.json`, "utf8");
  const deno = JSON.parse(text) as ManifestType;
  if (npm.name !== deno.name) throw new Error(`package.json names ${npm.name}, but deno.json names ${deno.name}.`);
  return { npm, deno, text };
}

/** Return the package version, or fail when the two manifests disagree on it. */
export function check(base = root): string {
  const { npm, deno } = read(base);
  if (npm.version !== deno.version) {
    throw new Error(`package.json is ${npm.version}, but deno.json is ${deno.version}. Run the release version step.`);
  }
  return npm.version;
}

/** Copy the version from `package.json` into `deno.json`, changing only that value; return the version. */
export function write(base = root): string {
  const { npm, deno, text } = read(base);
  if (npm.version !== deno.version) {
    writeFileSync(`${base}/deno.json`, text.replace(/("version"\s*:\s*)"[^"]*"/u, `$1${JSON.stringify(npm.version)}`));
  }
  return npm.version;
}

if (import.meta.main) {
  const version = process.argv.includes("--write") ? write(root) : check(root);
  console.log(`package.json and deno.json agree on ${version}.`);
}
