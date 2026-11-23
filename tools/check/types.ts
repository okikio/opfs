/**
 * Type-check every tracked TypeScript file, in the two environments the source targets.
 *
 * Deno checks the repository with `deno.json`'s compiler options, which include the DOM and Deno namespaces.
 * Files that load Bun's type definitions are checked in a second `deno check` call: Bun's globals redeclare
 * `URL`, `fetch` and others, and checking them together with everything else reports false errors in files
 * that never run on Bun. A file joins the Bun group by importing `bun-types` or a `bun:` module, so a new
 * Bun benchmark needs no edit here.
 *
 * A folder with its own `deno.json` (the npm build tool, for example) is checked with that configuration, since
 * its import map is not the package's.
 *
 * TypeScript itself then checks the browser and worker projects (`tsconfig.opfs-dom.json` and
 * `tsconfig.opfs-worker.json`), which pin the exact DOM and worker library sets the OPFS driver supports.
 *
 * @module
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { spawn } from "../spawn.ts";

const root = fileURLToPath(new URL("../../", import.meta.url));

/** Inert copies of upstream sources and generated declarations are data, not programs to check. */
const inert = [/^tests\/upstream\/original\//u, /\.d\.ts$/u];

/** Matches a file that loads Bun's type definitions. */
const bun = /["'](?:bun-types|bun:[a-z]+)["']/u;

/** Files to check together, and the Deno configuration they use (`undefined` means the root `deno.json`). */
export interface GroupType {
  readonly config?: string;
  readonly bun: boolean;
  readonly files: string[];
}

/** Tracked paths matching `patterns`, from `git ls-files`, so ignored and generated files are never checked. */
const list = (base: string, ...patterns: string[]) =>
  execFileSync("git", ["-C", base, "ls-files", "-z", "--", ...patterns], { encoding: "utf8" }).split("\0")
    .filter(Boolean);

/** Tracked TypeScript files, grouped by Deno configuration and by whether they load Bun's types. */
export function groupFiles(base = root): GroupType[] {
  const configs = list(base, "*/deno.json", "*/deno.jsonc").map((file) => file.slice(0, file.lastIndexOf("/") + 1));
  const result = new Map<string, GroupType>();
  for (const file of list(base, "*.ts", "*.mts")) {
    if (inert.some((pattern) => pattern.test(file))) continue;
    const folder = configs.find((prefix) => file.startsWith(prefix));
    const config = folder && list(base, `${folder}deno.json`).length
      ? `${folder}deno.json`
      : folder && `${folder}deno.jsonc`;
    const usesBun = bun.test(readFileSync(`${base}/${file}`, "utf8"));
    const key = `${config ?? ""}|${usesBun}`;
    const group = result.get(key) ?? { ...(config ? { config } : {}), bun: usesBun, files: [] };
    group.files.push(file);
    result.set(key, group);
  }
  return [...result.values()];
}

/** Run one checker and report whether it passed, so every group still runs after one fails. */
function passes(program: string, args: readonly string[]): boolean {
  try {
    spawn(program, args);
    return true;
  } catch (reason) {
    console.error((reason as Error).message);
    return false;
  }
}

if (import.meta.main) {
  const results = [
    ...groupFiles().map((group) =>
      passes("deno", [
        "check",
        "--quiet",
        // A nested configuration has no lockfile of its own; `--no-lock` keeps the check from writing one.
        ...(group.config ? ["--config", group.config, "--no-lock"] : ["--frozen", "--unstable-kv"]),
        ...group.files,
      ])
    ),
    passes("node", ["node_modules/typescript/bin/tsc", "-p", "tsconfig.opfs-dom.json"]),
    passes("node", ["node_modules/typescript/bin/tsc", "-p", "tsconfig.opfs-worker.json"]),
  ];
  process.exitCode = results.every(Boolean) ? 0 : 1;
}
