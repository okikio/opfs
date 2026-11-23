/**
 * Where Sampo lives and whether it has work to release.
 *
 * Sampo owns release intent: each change adds a Markdown changeset under `.sampo/changesets/` (run
 * `node_modules/.bin/sampo add`). The release steps read this module rather than repeating the paths.
 *
 * @module
 */
import { existsSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));

/** Sampo from the locked npm dev dependencies, so local and CI releases use one version. */
export const bin = `${root}node_modules/.bin/sampo`;

/** True when `.sampo/changesets/` holds at least one changeset that Sampo has not released yet. */
export function hasChangesets(): boolean {
  const folder = `${root}.sampo/changesets`;
  return existsSync(folder) && readdirSync(folder).some((name) => name.endsWith(".md"));
}
