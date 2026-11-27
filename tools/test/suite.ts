/**
 * Run discovered tests on one runtime.
 *
 * `node tools/test/suite.ts <deno|node|bun> [--family name ...] [--shard i/n] [file-or-directory ...]`
 *
 * Without selectors it runs every file the runtime supports, except the families that need an external
 * resource (`provider`, `netlify`, `interop`); CI runs those in their own lanes with `--family`. Selectors
 * narrow to exact files or folders, and an unknown selector is an error rather than an empty run.
 *
 * Each runtime gets the flags that make results comparable:
 *
 * - Deno runs with `--no-check` (type checking is its own gate) and explicit permissions. Tests may read and
 *   write files, start processes and listen on loopback; they get no other network. `kv` adds `--unstable-kv`.
 *   Selections containing the type-selection test can load native dependencies from `node_modules`.
 * - Node runs `node --test` with four files at once; each file is its own process.
 * - Bun runs `bun test` with a 30-second timeout per test, the slowest supported case.
 *
 * Two Deno-only modes reuse the same selection. `--stress` shuffles the order with a fixed seed and runs each
 * test three times, which finds tests that depend on ordering or leak state. `--coverage` collects a
 * coverage profile in `.tmp/reports/coverage/` (`deno coverage .tmp/reports/coverage` reports it).
 *
 * @module
 */
import { spawnSync } from "node:child_process";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { discover, type FamilyType, runsOn, runtimes, type RuntimeType, select, shard } from "./discover.ts";

const root = fileURLToPath(new URL("../../", import.meta.url));

/** Families that need a container engine, a native tool or an acquired SDK. They run only when named. */
export const external: readonly FamilyType[] = ["provider", "netlify", "interop"];

/** Deno permissions for test programs. Loopback only: a test must never reach the internet. */
const permissions = [
  "--allow-read",
  "--allow-write",
  "--allow-env",
  "--allow-run",
  "--allow-sys",
  "--allow-net=127.0.0.1,localhost,[::1]",
];

/** Deno-only run modes. */
export interface ModeType {
  readonly stress?: boolean;
  readonly coverage?: boolean;
}

/** The command that runs `files` on `runtime`. Exported so tests can check flags without starting a runtime. */
export function createCommand(
  runtime: RuntimeType,
  files: readonly string[],
  families: ReadonlySet<FamilyType>,
  mode: ModeType = {},
): string[] {
  if ((mode.stress || mode.coverage) && runtime !== "deno") throw new TypeError("--stress and --coverage need Deno.");
  switch (runtime) {
    case "deno":
      return [
        "deno",
        "test",
        "--no-check",
        "--frozen",
        "--sanitize-ops",
        "--sanitize-resources",
        // A fixed seed makes a shuffled failure reproducible with the same command.
        ...(mode.stress ? ["--shuffle=424242", "--repeats=2"] : []),
        ...(mode.coverage ? ["--clean", "--coverage=.tmp/reports/coverage"] : []),
        ...(families.has("kv") ? ["--unstable-kv"] : []),
        ...(families.has("netlify") ? ["--allow-all"] : [
          ...permissions,
          // The type-selection test loads Rolldown's native parser from the installed dependency tree.
          ...(files.includes("tools/check/types.test.ts") ? ["--allow-ffi=node_modules"] : []),
        ]),
        ...files,
      ];
    case "node":
      return ["node", "--test", "--test-concurrency=4", ...files];
    case "bun":
      return ["bun", "test", "--timeout", "30000", ...files.map((file) => `./${file}`)];
  }
}

if (import.meta.main) {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      family: { type: "string", multiple: true },
      shard: { type: "string" },
      list: { type: "boolean" },
      stress: { type: "boolean" },
      coverage: { type: "boolean" },
    },
  });
  const [runtime, ...selectors] = positionals;
  if (runtime !== "deno" && runtime !== "node" && runtime !== "bun") {
    throw new TypeError("Usage: run.ts <deno|node|bun> [--family name ...] [--shard i/n] [file-or-directory ...]");
  }
  const named = values.family as FamilyType[] | undefined;
  for (const family of named ?? []) {
    if (!(family in runtimes)) throw new TypeError(`Unknown test family ${family}.`);
  }
  const families = named ??
    Object.keys(runtimes).filter((family) => !external.includes(family as FamilyType)) as FamilyType[];
  const inventory = select(await discover(root), runtime, families);
  let files = inventory.filter((file) => runsOn(file, process.platform));
  for (const file of inventory) {
    if (!runsOn(file, process.platform)) console.log(`Not on ${process.platform}: ${file.path}. ${file.reason}`);
  }
  if (selectors.length) {
    const wanted = selectors.map((selector) => selector.replace(/^\.\//u, "").replace(/\/$/u, ""));
    for (const selector of wanted) {
      if (!files.some((file) => file.path === selector || file.path.startsWith(`${selector}/`))) {
        throw new TypeError(`No ${runtime} test matches ${selector}. Run with --list to see the inventory.`);
      }
    }
    files = files.filter((file) =>
      wanted.some((selector) => file.path === selector || file.path.startsWith(`${selector}/`))
    );
  }
  if (values.shard) {
    const match = /^(\d+)\/(\d+)$/u.exec(values.shard);
    if (!match) throw new TypeError("Pass --shard as <index>/<total>, for example 2/3.");
    files = shard(files, Number(match[1]), Number(match[2]));
  }
  if (values.list) {
    for (const file of files) console.log(`${file.family.padEnd(9)} ${file.path}`);
  } else if (files.length === 0) {
    console.log(`No ${runtime} tests in this selection.`);
  } else {
    const mode = { stress: values.stress ?? false, coverage: values.coverage ?? false };
    const [program, ...args] = createCommand(
      runtime,
      files.map((file) => file.path),
      new Set(files.map((file) => file.family)),
      mode,
    );
    console.log(`${runtime}: ${files.length} test file(s).`);
    const result = spawnSync(program!, args, { cwd: root, stdio: "inherit" });
    process.exitCode = result.status ?? 1;
  }
}
