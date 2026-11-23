/**
 * Preview the next release without writing anything: `node tools/release/plan.ts`.
 *
 * Pull requests run this. It fails when `package.json` and `deno.json` disagree, then prints the version and
 * changelog Sampo would produce from the pending changesets.
 *
 * @module
 */
import { fileURLToPath } from "node:url";
import * as manifest from "./manifest.ts";
import * as sampo from "./sampo.ts";
import { spawn } from "../spawn.ts";

const root = fileURLToPath(new URL("../../", import.meta.url));

manifest.check(root);
if (!sampo.hasChangesets()) console.log("No pending changesets. The version is unchanged.");
// Stacked pull requests target the branch below them; every stack lands on main.
else spawn(sampo.bin, ["release", "--dry-run"], { env: { SAMPO_RELEASE_BRANCH: "main" } });
