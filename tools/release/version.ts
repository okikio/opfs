/**
 * Consume the pending changesets into a new version: `node tools/release/version.ts`.
 *
 * Sampo writes the version into `package.json` and the notes into `CHANGELOG.md`; this step then copies the version
 * into `deno.json`. The Release workflow commits the result to a `release/versions` pull request. With no pending
 * changesets it changes nothing.
 *
 * @module
 */
import { fileURLToPath } from "node:url";
import * as manifest from "./manifest.ts";
import * as sampo from "./sampo.ts";
import { spawn } from "../spawn.ts";

const root = fileURLToPath(new URL("../../", import.meta.url));

if (!sampo.hasChangesets()) console.log("No pending changesets.");
else {
  spawn(sampo.bin, ["release"]);
  manifest.write(root);
}
