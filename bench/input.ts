import { createHash } from "node:crypto";
import { lstat, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { cwd } from "node:process";

/** Regular owned input kinds; links are never followed by the catalog. */
export type InputKindType = "file" | "directory" | "link" | "other";
/** Minimal filesystem boundary permits deterministic mutation and fault controls without native permissions. */
export interface InputFilesType {
  /** Inspects a path itself rather than its link target. Missing paths reject. */
  kind(path: string): Promise<InputKindType>;
  /** Lists direct children, retaining their physical kind. */
  entries(path: string): Promise<readonly { readonly name: string; readonly kind: InputKindType }[]>;
  /** Reads one regular input's exact bytes. */
  read(path: string): Promise<Uint8Array>;
}

/** Output/dependency trees are excluded at every depth, before enumeration. */
const excluded: ReadonlySet<string> = new Set([
  ".git",
  ".hg",
  ".svn",
  ".tmp",
  ".release",
  ".coverage",
  "node_modules",
  "coverage",
  "dist",
  "build",
  "output",
  "outputs",
  "reports",
  "artifacts",
  "test-results",
  "playwright-report",
  "blob-report",
]);
/** These current collector roots and manifests are required, not optional best-effort discoveries. */
const requiredFiles: readonly string[] = ["mod.ts", "deno.json", "deno.lock", "package.json"];
const requiredDirectories: readonly string[] = ["src", "bench", "tests", ".mise", ".mise/tasks"];

/** Native catalog adapter never calls stat, which would follow a symbolic link. */
const native: InputFilesType = {
  async kind(path) {
    const value = await lstat(path);
    return value.isSymbolicLink() ? "link" : value.isDirectory() ? "directory" : value.isFile() ? "file" : "other";
  },
  async entries(path) {
    return (await readdir(path, { withFileTypes: true })).map((value) => ({
      name: value.name,
      kind: value.isSymbolicLink() ? "link" : value.isDirectory() ? "directory" : value.isFile() ? "file" : "other",
    }));
  },
  read: readFile,
};

/** Correctness test definitions are not workloads. Benchmark specifications and inert .txt snapshots remain admitted. */
function definition(name: string): boolean {
  return /(?:[._](?:test|spec))\.(?:[cm]?[jt]sx?)$/u.test(name);
}

/**
 * Hashes a conservative maintained support catalog, not a parsed import graph.
 *
 * All production and benchmark bytes, test support/fixtures (including raw
 * provenance), command wrappers and root dependency/configuration metadata are
 * admitted. This can include unexecuted support. It avoids manually listing
 * individual helpers such as gate.ts, close.ts or browser/profile.ts. Correctness
 * test/spec definitions are excluded outside bench/, whose specifications are
 * workloads. OS metadata, links, dependencies and output trees are excluded everywhere.
 * Benchmarks must keep executed support inside these maintained roots.
 * The required roots/manifests must be regular physical owned paths. A link in
 * an optional subtree is omitted, and may never be an executed workload input.
 */
export async function inputs(root = cwd(), files: InputFilesType = native): Promise<Record<string, string>> {
  await requireKind("", "directory");
  for (const name of requiredDirectories) await requireKind(name, "directory");
  for (const name of requiredFiles) await requireKind(name, "file");
  const selected = new Set(requiredFiles);
  // Runtime resolution and installation metadata can change without editing a
  // module. Record present root lock/config files, including newly added ones.
  for (const entry of await files.entries(root)) {
    if (
      entry.kind === "file" &&
      (/^(?:deno(?:\..+)?|package(?:-lock)?|tsconfig(?:\..+)?)\.jsonc?$/u.test(entry.name) ||
        /(?:^|[-.])lock\.(?:yaml|json)$/u.test(entry.name) || entry.name === ".npmrc")
    ) selected.add(entry.name);
  }
  for (const name of ["src", "bench", "tests", ".mise/tasks"]) await visit(name);
  const result: Record<string, string> = {};
  for (const name of [...selected].sort()) {
    // Reinspect before reading: a link introduced after enumeration is not an
    // admitted input. This is a trusted workspace receipt, not a hostile-race sandbox.
    await requireKind(name, "file");
    result[name] = createHash("sha256").update(await files.read(join(root, name))).digest("hex");
  }
  return result;

  async function requireKind(name: string, expected: InputKindType): Promise<void> {
    if (await files.kind(join(root, name)) !== expected) {
      throw new Error(`Benchmark input must be a regular ${expected}: ${name}`);
    }
  }
  async function visit(directory: string): Promise<void> {
    for (const entry of await files.entries(join(root, directory))) {
      if (excluded.has(entry.name) || entry.name === ".DS_Store") continue;
      const name = `${directory}/${entry.name}`;
      if (directory === ".mise/tasks" && !entry.name.startsWith("bench") && entry.name !== "test-filesystem-clients") {
        continue;
      }
      if (entry.kind === "directory") {
        await requireKind(name, "directory");
        await visit(name);
      } else if (
        entry.kind === "file" &&
        (directory === "bench" || directory.startsWith("bench/") || !definition(entry.name))
      ) selected.add(name);
    }
  }
}

/** Canonical complete path/hash maps detect byte mutations, additions and removals. */
export function verifyInputs(before: Readonly<Record<string, string>>, after: Readonly<Record<string, string>>): void {
  const canonical = (value: Readonly<Record<string, string>>) =>
    JSON.stringify(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
  if (canonical(before) !== canonical(after)) throw new Error("Benchmark source inputs changed; discard timings.");
}

/** Input admission is distinct from test success or measurement completeness. */
export interface InputReceiptType {
  /** Version of the conservative catalog receipt. */
  readonly version: 1;
  /** Unchanged inputs alone do not prove a successful browser workload. */
  readonly status: "running" | "unchanged" | "invalid";
  /** Complete input identity before workload admission. */
  readonly inputs: Readonly<Record<string, string>>;
  /** Complete identity after the workload, when acquisition succeeded. */
  readonly inputsAfter?: Readonly<Record<string, string>>;
  /** Admission/read/comparison failure retained independently of raw benchmark output. */
  readonly failure?: string;
}

/**
 * Writes a running receipt before admitting work, then returns its after-work
 * guard. Every returned receipt is detached from earlier save callbacks. A
 * changed, missing or unreadable input writes invalid evidence and rejects.
 * Failure to persist invalid evidence retains both the admission and disk errors.
 */
export async function openInputGuard(
  save: (receipt: InputReceiptType) => Promise<void>,
  root = cwd(),
  files: InputFilesType = native,
): Promise<() => Promise<void>> {
  let before: Record<string, string>;
  try {
    before = await inputs(root, files);
  } catch (error) {
    try {
      await save({ version: 1, status: "invalid", inputs: {}, failure: String(error) });
    } catch (disk) {
      throw new AggregateError([error, disk], "Benchmark admission and evidence write failed.", { cause: error });
    }
    throw error;
  }
  await save({ version: 1, status: "running", inputs: { ...before } });
  return async () => {
    let after: Record<string, string> | undefined;
    try {
      after = await inputs(root, files);
      verifyInputs(before, after);
    } catch (error) {
      try {
        await save({
          version: 1,
          status: "invalid",
          inputs: { ...before },
          ...(after ? { inputsAfter: { ...after } } : {}),
          failure: String(error),
        });
      } catch (disk) {
        throw new AggregateError([error, disk], "Benchmark admission and evidence write failed.", { cause: error });
      }
      throw error;
    }
    await save({ version: 1, status: "unchanged", inputs: { ...before }, inputsAfter: { ...after } });
  };
}
