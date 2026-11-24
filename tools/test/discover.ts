/**
 * Discover every authored test once, then classify the few that need a particular runtime or external resource.
 *
 * A new `tests/**\/*.test.ts` file runs on Deno, Node.js and Bun with no edit anywhere else. Only a file whose
 * needs differ gets a rule below, and each rule says why. Tests for one subject live in one folder, such as
 * `tests/zip/` or `tests/s3/`. A new provider test (`provider.test.ts` or `*-provider.test.ts`, in any folder) joins
 * the provider family by its name; the few other families are named by path.
 *
 * ```text
 *   tests/**\/*.test.ts ─► classify(path) ─► family ─► runtimes and CI lane
 *   tests/browser/*.spec.ts ─────────────────────────► Playwright (its own config discovers them)
 * ```
 *
 * @module
 */
import { readdir } from "node:fs/promises";
import { join, relative, sep } from "node:path";

/** Native test hosts. Browser behavior has its own Playwright task. */
export type RuntimeType = "deno" | "node" | "bun";

/** Why a test needs a particular host. The family decides the runtimes and the CI lane. */
export type FamilyType =
  | "portable"
  | "sqlite"
  | "process"
  | "deno"
  | "kv"
  | "node"
  | "bun"
  | "provider"
  | "netlify"
  | "interop";

/** Operating systems, spelled as `process.platform` reports them. */
export type PlatformType = "linux" | "darwin" | "win32";

/** A discovered test file and the reason it is not portable, when it is not. */
export interface TestFileType {
  readonly path: string;
  readonly family: FamilyType;
  readonly reason: string;
  /**
   * Operating systems the test can run on, when it cannot run on all of them. `reason` says why. The suite reports
   * a file it leaves out for this, so the limit is visible in every run instead of a skip inside the test.
   */
  readonly platforms?: readonly PlatformType[];
}

/** The runtimes each family runs on. A family absent from a runtime's list is never run there. */
export const runtimes: Readonly<Record<FamilyType, readonly RuntimeType[]>> = {
  portable: ["deno", "node", "bun"],
  sqlite: ["deno", "node"],
  process: ["deno", "node"],
  deno: ["deno"],
  kv: ["deno"],
  node: ["node"],
  bun: ["bun"],
  provider: ["node"],
  netlify: ["deno"],
  interop: ["deno"],
};

/** Folders that never hold authored test programs, or hold inert upstream snapshots. */
const ignored = new Set(["node_modules", ".tmp", ".git", "original", "upstream-raw"]);

/**
 * Tests kept beside the fixture they check. Most of `tests/fixtures/` is data, so only these run; each one
 * compares a fixture against the native producer it was built from.
 */
const fixtureTests: Readonly<
  Record<string, { family: FamilyType; reason: string; platforms?: readonly PlatformType[] }>
> = {
  "tests/fixtures/arrow/runner.test.ts": {
    family: "node",
    reason: "Supervises the Arrow fixture producer with Node child-process signals and reads `/proc/<pid>/stat`, " +
      "which only Linux provides.",
    platforms: ["linux"],
  },
  "tests/fixtures/bam/dictionary.test.ts": {
    family: "node",
    reason: "Compares the BAM DEFLATE dictionary with Node's zlib, the producer's oracle.",
  },
  "tests/fixtures/bam/codec.test.ts": {
    family: "node",
    reason: "Compares the BGZF codec with Node's zlib, the producer's oracle.",
  },
  "tests/fixtures/ipc/layout.test.ts": {
    family: "portable",
    reason: "Checks the Arrow IPC fixture layout against its specification offsets.",
  },
  "tests/fixtures/kafka/metadata.test.ts": {
    family: "deno",
    reason: "Reads the retained Kafka metadata receipts with Deno's file permissions.",
  },
};

/** Classify one repository-relative test path. Ordinary tests are portable. */
export function classify(path: string): TestFileType {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const fixture = fixtureTests[path];
  if (fixture) return { path, ...fixture };
  if (name.startsWith("netlify-") || (path.startsWith("tests/netlify/") && name !== "mod.test.ts")) {
    return {
      path,
      family: "netlify",
      reason: "Runs the bundled Netlify candidate against the frozen SDK closure inside Deno.",
    };
  }
  if (name === "provider.test.ts" || name.endsWith("-provider.test.ts") || path === "tests/provider/mod.test.ts") {
    return { path, family: "provider", reason: "Starts provider containers with Testcontainers." };
  }
  if (["tests/compress-process.test.ts", "tests/tar/process.test.ts", "tests/zip/process.test.ts"].includes(path)) {
    return {
      path,
      family: "interop",
      reason: "Compares archives with installed native consumers (7-Zip, bsdtar, unzip).",
    };
  }
  if (name === "fixture-group.test.ts" || path === "tests/process.test.ts") {
    return { path, family: "process", reason: "Signals child process groups, which Bun does not model the same way." };
  }
  if (name === "transfer-process.test.ts") {
    return { path, family: "deno", reason: "Kills and restarts a Node.js upload process from a Deno supervisor." };
  }
  if (name === "deno.test.ts") return { path, family: "deno", reason: "Tests the Deno filesystem driver." };
  if (path === "tests/deno-kv/mod.test.ts" || name === "generation.test.ts") {
    return { path, family: "kv", reason: "Needs Deno KV (`--unstable-kv`)." };
  }
  if (name === "bun.test.ts") return { path, family: "bun", reason: "Tests the Bun filesystem driver." };
  if (name === "node.test.ts" || path === "tests/record/node.test.ts") {
    return { path, family: "node", reason: "Tests the Node.js filesystem driver." };
  }
  if (name === "d1.test.ts") {
    return { path, family: "sqlite", reason: "Needs `node:sqlite`, which Bun does not provide." };
  }
  return { path, family: "portable", reason: "Runs unchanged on every runtime." };
}

/** True for an authored test program: `*.test.ts`, or Deno's `*_test.ts` spelling. */
function isTest(name: string): boolean {
  return name.endsWith(".test.ts") || name.endsWith("_test.ts");
}

/** Walk `tests/` and `tools/`, returning every test in a stable order. Browser specs are Playwright's to discover. */
export async function discover(root: string): Promise<TestFileType[]> {
  const found: TestFileType[] = [];
  const visit = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      if (ignored.has(entry.name)) continue;
      const full = join(directory, entry.name);
      const path = relative(root, full).split(sep).join("/");
      if (entry.isDirectory()) {
        // Fixture folders are data. Only the named fixture tests above are programs.
        if (
          path.startsWith("tests/fixtures") && !Object.keys(fixtureTests).some((test) => test.startsWith(`${path}/`))
        ) {
          continue;
        }
        await visit(full);
      } else if (isTest(entry.name) && (!path.startsWith("tests/fixtures/") || fixtureTests[path])) {
        found.push(classify(path));
      }
    }
  };
  await visit(join(root, "tests"));
  await visit(join(root, "tools"));
  return found;
}

/** True when a file can run on `platform`. A file with no `platforms` runs everywhere. */
export function runsOn(file: TestFileType, platform: string): boolean {
  return !file.platforms || (file.platforms as readonly string[]).includes(platform);
}

/**
 * The discovered files one runtime runs, optionally narrowed to a set of families and to one operating system.
 * Leave `platform` out to ignore platform limits, for example when listing the full inventory.
 */
export function select(
  files: readonly TestFileType[],
  runtime: RuntimeType,
  families?: readonly FamilyType[],
  platform?: string,
): TestFileType[] {
  return files.filter((file) =>
    runtimes[file.family].includes(runtime) && (!families || families.includes(file.family)) &&
    (platform === undefined || runsOn(file, platform))
  );
}

/**
 * Return shard `index` of `total`, counting from 1. Files are sorted and dealt in turn, so each shard's list is
 * stable across runs and every file runs in exactly one shard.
 */
export function shard<T extends { readonly path: string }>(files: readonly T[], index: number, total: number): T[] {
  if (!Number.isSafeInteger(total) || total < 1 || !Number.isSafeInteger(index) || index < 1 || index > total) {
    throw new RangeError(`A shard is <index>/<total> with 1 <= index <= total; received ${index}/${total}.`);
  }
  return files.toSorted((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    .filter((_, position) => position % total === index - 1);
}
