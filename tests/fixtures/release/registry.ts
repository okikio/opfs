/** Release-test command double. It changes only the fixture's registry state.
 * Real Bumpy and real candidate tarballs remain outside this mock boundary. @module
 */
import { Buffer } from "node:buffer";
import { readFileSync, writeFileSync } from "node:fs";
import process from "node:process";

/** Test-owned mutable registry observations and attempted uploads, never live registry data. */
interface RegistryStateType {
  npm: boolean;
  jsr: boolean;
  status?: number;
  different?: boolean;
  failUpload?: boolean;
  staleJsr?: boolean;
  jsrCache?: Record<string, number>;
  uploads: string[][];
  archive: string;
}
const path = process.env.REGISTRY_STATE;
if (!path) throw new Error("Release registry double requires its owned state path.");
const state: RegistryStateType = JSON.parse(readFileSync(path, "utf8")), args = process.argv.slice(2);
if (process.env.REGISTRY_COMMAND === "npm") {
  if (args[0] !== "publish") throw new Error("Unexpected fake npm operation");
  // Record the attempt before the deliberate refusal, so failure tests see both.
  state.uploads.push(args);
  writeFileSync(path, JSON.stringify(state));
  if (state.failUpload) process.exit(9);
  state.npm = true;
  writeFileSync(path, JSON.stringify(state));
  process.exit(0);
}
const url = args.at(-1);
if (!url) throw new Error("Release registry double requires a request URL.");
const npm = url.startsWith("https://registry.npmjs.org/");
if (url.endsWith(".tgz")) {
  process.stdout.write(state.different ? Buffer.from("different archive") : readFileSync(state.archive));
  process.exit(0);
}
const origin = state.status ?? ((npm ? state.npm : state.jsr) ? 200 : 404);
let status = origin;
if (!npm && state.staleJsr) {
  state.jsrCache ??= {};
  status = state.jsrCache[url] ??= origin;
  writeFileSync(path, JSON.stringify(state));
}
const body = JSON.stringify({
  name: "@okikio/opfs",
  version: "0.1.0",
  dist: { tarball: "https://registry.npmjs.org/@okikio/opfs/-/opfs-0.1.0.tgz" },
});
process.stdout.write(body + (args.includes("--write-out") ? "\n" + status : ""));
if (args.includes("--fail") && status >= 400) process.exit(22);
