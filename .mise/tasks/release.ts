/** Uses Bumpy's release model with Deno manifests and independently resumable registry uploads. @module */
import process from "node:process";
import { createHash } from "node:crypto";
import { dirname, relative, resolve } from "node:path";
import {
  applyReleasePlan,
  assembleReleasePlan,
  defaultFormatter,
  DependencyGraph,
  discoverPackages,
  loadConfig,
  loadFormatter,
  publishPackages,
  readBumpFiles,
} from "npm:@varlock/bumpy@1.18.1";
import type { PlannedRelease, ReleasePlan, WorkspacePackage } from "npm:@varlock/bumpy@1.18.1";

/** A prepared upload records exactly which source tree and archive passed the release gates. */
interface CandidateType {
  source: string;
  revision: string;
  created: string;
  gates: { file: string; sha256: string };
  packages: Array<{ name: string; version: string; archive: string; sha256: string }>;
}
const ROOT = Deno.cwd();
const STORE = ".tmp/releases";
const config = await loadConfig(ROOT);
const packages = await discoverPackages(ROOT, config);
const graph = new DependencyGraph(packages);
const command = Deno.args[0] ?? "plan";
const target = Deno.args[1] ?? "both";
await metadata();
if (command === "plan" || command === "version") {
  const { bumpFiles, errors } = await readBumpFiles(ROOT);
  if (errors.length) throw new Error(errors.join("\n"));
  const plan = assembleReleasePlan(bumpFiles, packages, graph, config);
  if (plan.warnings.length) throw new Error(plan.warnings.join("\n"));
  if (command === "plan") console.log(JSON.stringify(plan, null, 2));
  else {
    if (
      config.changelog && config.changelog !== "default" &&
      await loadFormatter(config.changelog, ROOT) === defaultFormatter
    ) {
      throw new Error(
        "The configured changelog formatter failed; refusing to silently replace authored stories.",
      );
    }
    await Deno.mkdir(STORE, { recursive: true });
    // Retain the authored notes and their exact propagation plan before Bumpy consumes them.
    await save(`${STORE}/version-plan.json`, plan);
    await applyReleasePlan(plan, packages, ROOT, config);
    const changelogs: string[] = [];
    for (const release of plan.releases) {
      const member = packages.get(release.name)!;
      const path = `${member.dir}/deno.json`;
      const source = await Deno.readTextFile(path);
      await Deno.writeTextFile(
        path,
        source.replace(/("version"\s*:\s*")[^"]+(")/u, `$1${release.newVersion}$2`),
      );
      const changelog = `${member.dir}/CHANGELOG.md`;
      try {
        if ((await Deno.stat(changelog)).isFile) changelogs.push(changelog);
      } catch (error) {
        if (!(error instanceof Deno.errors.NotFound)) throw error;
      }
    }
    // Authored Markdown keeps its examples while adopting the repository's formatter.
    if (changelogs.length) await run(Deno.execPath(), ["fmt", ...changelogs]);
    console.log(
      "Bumpy versions, dependency ranges, release notes, and Deno versions written. Run release:prepare next.",
    );
  }
} else if (command === "prepare") {
  const result = await prepareSnapshot();
  await save(`${STORE}/manifests.json`, result.manifests);
  await save(`${STORE}/prepared.json`, result.candidate);
  console.log("Snapshot gates, exact release archives and source identity recorded in .tmp/releases/.");
} else if (command === "publish") {
  await cleanRevision();
  registries(target);
  const candidate = await prepared();
  // Preflight every registry/package before any irreversible upload. A 401, 403, timeout,
  // or malformed response is an error, never evidence that a version is available.
  for (const row of candidate.packages) {
    for (const registry of registries(target)) {
      if (await published(registry, row.name, row.version)) await samePublication(registry, row, candidate);
    }
  }
  for (const row of candidate.packages) {
    const member = packages.get(row.name)!;
    const release: PlannedRelease = {
      name: row.name,
      type: "patch",
      oldVersion: row.version,
      newVersion: row.version,
      bumpFiles: [],
      isDependencyBump: false,
      isCascadeBump: false,
      isGroupBump: false,
      bumpSources: [],
    };
    const plan: ReleasePlan = { bumpFiles: [], releases: [release], warnings: [] };
    const bytes = await Deno.readTextFile(`${member.dir}/package.json`);
    const previous = member.bumpy;
    member.bumpy = {
      ...previous,
      publishCommand: `${quote(Deno.execPath())} task --cwd ${quote(ROOT)} release:upload ${quote(row.name)} ${
        quote(row.version)
      } ${quote(target)}`,
    };
    const failures: unknown[] = [];
    try {
      // The custom Deno command owns dual-registry credentials and provenance. Bumpy's
      // default npm auth setup writes .npmrc; selecting the unused Bun manager bypasses
      // that setup. Its public pipeline still owns ordering and command failure results.
      const result = await publishPackages(
        plan,
        packages,
        graph,
        { ...config, publish: { ...config.publish, publishManager: "bun", provenance: false } },
        ROOT,
        { noTag: true },
      );
      if (result.failed.length || result.published.length !== 1) {
        throw new Error(JSON.stringify(result));
      }
    } catch (reason) {
      failures.push(reason);
    } finally {
      // Bumpy resolves workspace protocols in place for custom commands. Restore the
      // development manifest, even when a registry rejects an upload.
      try {
        await Deno.writeTextFile(`${member.dir}/package.json`, bytes);
      } catch (reason) {
        failures.push(reason);
      }
      if (previous === undefined) delete member.bumpy;
      else member.bumpy = previous;
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) {
      throw new AggregateError(failures, "Publication and manifest restoration failed.", {
        cause: failures[0],
      });
    }
  }
  console.log(
    "Requested registry uploads completed. Verify fresh public installs before declaring this release complete.",
  );
} else if (command === "upload") {
  const name = Deno.args[1]!;
  const version = Deno.args[2]!;
  const selected = Deno.args[3] ?? "both";
  await restoreProtocols();
  await cleanRevision();
  const candidate = await prepared();
  const row = candidate.packages.find((row) => row.name === name && row.version === version);
  if (!row) throw new Error("Package/version is absent from the prepared release set.");
  for (const registry of registries(selected)) {
    const member = packages.get(name)!;
    for (const dependency of Object.keys(member.dependencies)) {
      const internal = packages.get(dependency);
      if (internal && !(await published(registry, internal.name, internal.version))) {
        throw new Error(`${registry} dependency is unavailable: ${internal.name}@${internal.version}`);
      }
    }
    const exists = await published(registry, name, version);
    if (exists) await samePublication(registry, row, candidate);
    else {
      if (registry === "jsr") {
        const member = packages.get(name)!;
        await run(Deno.execPath(), ["publish"], member.dir);
      } else {
        const args = [
          "publish",
          resolve(ROOT, row.archive),
          "--registry=https://registry.npmjs.org",
          "--access=public",
        ];
        if (Deno.env.get("GITHUB_ACTIONS") === "true") args.push("--provenance");
        await run(Deno.execPath(), ["task", "release:npm", ...args.slice(1)]);
      }
    }
    if (!(await visible(registry, name, version))) {
      throw new Error(`${registry} did not expose ${name}@${version} after upload.`);
    }
    if (registry === "npm") await sameNpmArchive(row);
    await save(`${STORE}/${name.replace(/[@/]/gu, "-")}-${version}-${registry}.json`, {
      name,
      version,
      registry,
      archiveSha256: row.sha256,
      source: candidate.source,
      revision: candidate.revision,
      confirmed: new Date().toISOString(),
    });
  }
} else if (command === "registry") {
  for (const member of packages.values()) {
    for (const registry of registries(target)) {
      console.log(
        JSON.stringify({
          registry,
          name: member.name,
          version: member.version,
          published: await published(registry, member.name, member.version),
        }),
      );
    }
  }
} else throw new Error(`Unknown release operation: ${command}`);

/** Checks the two manifest authorities before Bumpy sees or writes a release. */
async function metadata(): Promise<void> {
  if (!packages.size) throw new Error("Bumpy discovered no packages.");
  for (const member of packages.values()) {
    const deno = JSON.parse(await Deno.readTextFile(`${member.dir}/deno.json`)) as {
      name: string;
      version: string;
    };
    if (member.name !== deno.name || member.version !== deno.version) {
      throw new Error(`${member.name}: npm and Deno metadata disagree.`);
    }
    if (!/^\d+\.\d+\.\d+$/u.test(member.version)) {
      throw new Error("Stable releases require an explicit stable SemVer version.");
    }
  }
}
/** Maps a release member to the archive produced by its existing package compiler. */
function archivePath(member: WorkspacePackage, opfs = packages.has("@okikio/opfs")): string {
  const filename = `${member.name.replace(/^@/u, "").replace("/", "-")}-${member.version}.tgz`;
  return `${opfs ? ".release/npm" : ".tmp/packages"}/${filename}`;
}
/** Validates registry selection before any publication. */
function registries(value: string): Array<"jsr" | "npm"> {
  if (value === "both") return ["jsr", "npm"];
  if (value === "jsr" || value === "npm") return [value];
  throw new Error(`Unknown registry selection: ${value}`);
}
/** Queries exact versions, including older published versions, without hiding transport errors. */
async function published(registry: "jsr" | "npm", name: string, version: string): Promise<boolean> {
  const url = registry === "jsr"
    ? `https://jsr.io/api/scopes/${name.slice(1).replace("/", "/packages/")}/versions/${version}`
    : `https://registry.npmjs.org/${encodeURIComponent(name)}/${version}`;
  const request = new URL(url);
  // A cached preflight 404 can outlive a successful JSR upload. Each management
  // observation needs a fresh URL; Cache-Control: no-cache does not bypass its CDN.
  if (registry === "jsr") request.searchParams.set("release_check", crypto.randomUUID());
  const result = await new Deno.Command("curl", {
    args: ["--silent", "--show-error", "--max-time", "30", "--write-out", "\n%{http_code}", request.href],
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (!result.success) {
    throw new Error(`Registry request failed: ${new TextDecoder().decode(result.stderr)}`);
  }
  const output = new TextDecoder().decode(result.stdout);
  const split = output.lastIndexOf("\n");
  const status = Number(output.slice(split + 1));
  if (status === 404) return false;
  if (status !== 200) {
    throw new Error(`${registry} metadata returned HTTP ${status} for ${name}@${version}.`);
  }
  const value = JSON.parse(output.slice(0, split)) as { version?: string };
  if (value.version !== version) throw new Error(`${registry} metadata has a different version.`);
  return true;
}
/** Rejects changed archives/source after the release gates. Bumpy may only rewrite
 * workspace ranges transiently; upload subprocesses normalize those to their saved values. */
async function prepared(): Promise<CandidateType> {
  const candidate = JSON.parse(await Deno.readTextFile(`${STORE}/prepared.json`)) as CandidateType;
  if (candidate.revision !== await revision()) {
    throw new Error("Prepared revision differs from the publishing checkout.");
  }
  if (candidate.source !== await sourceHash()) {
    throw new Error("Source changed after release preparation. Run release:prepare again.");
  }
  if (
    candidate.packages.length !== packages.size ||
    new Set(candidate.packages.map((row) => row.name)).size !== packages.size
  ) throw new Error("Prepared release set differs from the workspace.");
  for (const row of candidate.packages) {
    const member = packages.get(row.name);
    if (!member || member.version !== row.version || row.archive !== archivePath(member)) {
      throw new Error("Prepared package metadata differs from the workspace.");
    }
    if (row.sha256 !== await hash(await Deno.readFile(row.archive))) {
      throw new Error(`Release archive changed: ${row.archive}`);
    }
  }
  if (
    !candidate.gates ||
    !new RegExp(`^${STORE.replaceAll(".", "\\.")}\/gates-${candidate.revision}-[a-f0-9-]{36}\\.json$`, "u").test(
      candidate.gates.file,
    ) ||
    candidate.gates.sha256 !== await hash(await Deno.readFile(candidate.gates.file))
  ) {
    throw new Error("Prepared gate evidence changed or is missing.");
  }
  const journal = JSON.parse(await Deno.readTextFile(candidate.gates.file)) as {
    passed?: boolean;
    source?: string;
    revision?: string;
    steps?: GateType[];
  };
  if (
    journal.passed !== true || journal.source !== candidate.source || journal.revision !== candidate.revision ||
    !Array.isArray(journal.steps) ||
    journal.steps.some((step) =>
      step.code !== 0 || step.source !== candidate.source || step.revision !== candidate.revision ||
      step.before.source !== candidate.source || step.before.revision !== candidate.revision
    )
  ) throw new Error("Prepared gate journal differs from the successful source snapshot.");
  for (const step of journal.steps) {
    if (step.phase !== "dependencies") continue;
    if (!step.logs) throw new Error("Prepared dependency phase lacks raw evidence.");
    for (const stream of [step.logs.stdout, step.logs.stderr]) {
      const prefix = `${STORE}/snapshot-${candidate.revision}-`;
      if (
        !stream.file.startsWith(prefix) ||
        !/^snapshot-[a-f0-9]{40}-[a-f0-9-]{36}\/dependencies\/(?:stdout|stderr)\.log$/u.test(
          stream.file.slice(STORE.length + 1),
        ) || stream.sha256 !== await fileHash(stream.file)
      ) throw new Error("Prepared dependency raw evidence changed or is missing.");
    }
  }
  return candidate;
}
/** Hashes publishable and maintained source inputs, including untracked release files.
 * Local outputs and caches remain excluded by the repository's Git ignore rules. */
async function sourceHash(cwd = ROOT): Promise<string> {
  const values: Array<[string, string]> = [];
  for (const path of await sourcePaths(cwd)) {
    try {
      values.push([path, await hash(await Deno.readFile(resolve(cwd, path)))]);
    } catch (reason) {
      if (reason instanceof Deno.errors.NotFound) values.push([path, "deleted"]);
      else throw reason;
    }
  }
  return await hash(new TextEncoder().encode(JSON.stringify(values)));
}
/** Uses SHA-256 for source and archive identities; this is provenance, not a signature. */
async function hash(bytes: Uint8Array): Promise<string> {
  return Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(bytes).buffer)),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}
/** Hashes retained raw logs with a fixed buffer and explicit file ownership. */
async function fileHash(path: string): Promise<string> {
  const file = await Deno.open(path);
  const digest = createHash("sha256"), buffer = new Uint8Array(65536);
  const errors: unknown[] = [];
  let value: string | undefined;
  try {
    while (true) {
      const size = await file.read(buffer);
      if (size === null) break;
      digest.update(buffer.subarray(0, size));
    }
    value = digest.digest("hex");
  } catch (reason) {
    errors.push(reason);
  } finally {
    try {
      file.close();
    } catch (reason) {
      errors.push(reason);
    }
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) {
    throw new AggregateError(errors, "Raw evidence hashing and file cleanup failed.", { cause: errors[0] });
  }
  if (value === undefined) throw new Error("Raw evidence hash is absent.");
  return value;
}

/** Writes local receipts only after an independently observed registry success. */
async function save(path: string, value: unknown): Promise<void> {
  await Deno.writeTextFile(path, `${JSON.stringify(value, null, 2)}\n`);
}
/** Quotes one controlled executable/path for Bumpy's shell command seam. */
function quote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
/** Runs actual Deno/npm commands without suppressing their exit status or diagnostics. */
async function run(file: string, args: string[], cwd = ROOT): Promise<void> {
  const status = await new Deno.Command(file, {
    args,
    cwd,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  }).spawn().status;
  if (!status.success) throw new Error(`${file} failed with exit code ${status.code}.`);
}

/** Accepts only Bumpy's documented workspace-protocol resolution, then restores
 * the exact saved development manifest before verifying the full source identity. */
async function restoreProtocols(): Promise<void> {
  const originals = JSON.parse(await Deno.readTextFile(`${STORE}/manifests.json`)) as Record<
    string,
    string
  >;
  for (const member of packages.values()) {
    const original = originals[member.name];
    if (original === undefined) throw new Error("Prepared manifest is missing.");
    const path = `${member.dir}/package.json`;
    const current = await Deno.readTextFile(path);
    if (current === original) continue;
    const expected = JSON.parse(original) as Record<string, unknown>;
    for (
      const field of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]
    ) {
      const deps = expected[field] as Record<string, string> | undefined;
      for (const [name, range] of Object.entries(deps ?? {})) {
        if (!range.startsWith("workspace:")) continue;
        const version = packages.get(name)?.version;
        if (!version) throw new Error(`Unknown workspace dependency: ${name}`);
        const suffix = range.slice(10);
        deps![name] = suffix === "*"
          ? `^${version}`
          : suffix === "^" || suffix === "~"
          ? `${suffix}${version}`
          : suffix;
      }
    }
    if (JSON.stringify(JSON.parse(current)) !== JSON.stringify(expected)) {
      throw new Error("Unexpected source manifest edit during publication.");
    }
    await Deno.writeTextFile(path, original);
  }
}

/** Returns the immutable Git revision represented by a clean publishing checkout. */
async function revision(cwd = ROOT): Promise<string> {
  const result = await new Deno.Command("git", {
    args: ["rev-parse", "HEAD"],
    cwd,
    stdout: "piped",
    stderr: "inherit",
  }).output();
  const sha = new TextDecoder().decode(result.stdout).trim();
  if (!result.success || !/^[a-f0-9]{40}$/u.test(sha)) {
    throw new Error("Cannot identify the source revision.");
  }
  return sha;
}
/** Preparation and upload both require committed immutable source. Planning and versioning remain edit-capable. */
async function cleanRevision(cwd = ROOT): Promise<void> {
  const result = await new Deno.Command("git", {
    args: ["-c", "core.fsmonitor=false", "status", "--porcelain"],
    cwd,
    stdout: "piped",
    stderr: "inherit",
  }).output();
  if (!result.success || result.stdout.length) {
    throw new Error(
      "Publication requires a clean immutable checkout. Preserve local work and publish its prepared release snapshot.",
    );
  }
}

/** Accepts an existing JSR version only with the retained source/revision receipt.
 * npm can recover a lost receipt by independently downloading the immutable archive. */
async function samePublication(
  registry: "jsr" | "npm",
  row: CandidateType["packages"][number],
  candidate: CandidateType,
): Promise<void> {
  if (registry === "npm") {
    await sameNpmArchive(row);
    return;
  }
  const path = `${STORE}/${row.name.replace(/[@/]/gu, "-")}-${row.version}-${registry}.json`;
  let receipt: { source: string; archiveSha256: string; revision: string };
  try {
    receipt = JSON.parse(await Deno.readTextFile(path));
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      throw new Error(
        `JSR already contains ${row.name}@${row.version} without a retained source receipt. Independently verify its published source; do not guess that the bytes match.`,
      );
    }
    throw error;
  }
  if (
    receipt.source !== candidate.source || receipt.archiveSha256 !== row.sha256 ||
    receipt.revision !== candidate.revision
  ) throw new Error("Existing JSR receipt belongs to a different candidate.");
}
/** Fetches the exact direct npm archive and checks SHA-256 against the prepared upload. */
async function sameNpmArchive(row: CandidateType["packages"][number]): Promise<void> {
  const url = `https://registry.npmjs.org/${encodeURIComponent(row.name)}/${row.version}`;
  const metadata = await new Deno.Command("curl", {
    args: ["--fail", "--silent", "--show-error", "--max-time", "30", url],
    stdout: "piped",
    stderr: "inherit",
  }).output();
  if (!metadata.success) throw new Error("Cannot inspect the published npm archive.");
  const value = JSON.parse(new TextDecoder().decode(metadata.stdout)) as {
    name: string;
    version: string;
    dist: { tarball: string };
  };
  if (
    value.name !== row.name || value.version !== row.version ||
    !value.dist.tarball.startsWith("https://registry.npmjs.org/")
  ) throw new Error("Unexpected npm archive identity.");
  const archive = await new Deno.Command("curl", {
    args: ["--fail", "--silent", "--show-error", "--max-time", "60", value.dist.tarball],
    stdout: "piped",
    stderr: "inherit",
  }).output();
  if (!archive.success || await hash(archive.stdout) !== row.sha256) {
    throw new Error("Published npm bytes differ from the prepared archive.");
  }
}
/** Allows bounded registry propagation delay while treating transport/auth failures as errors. */
async function visible(registry: "jsr" | "npm", name: string, version: string): Promise<boolean> {
  for (let attempt = 0; attempt < 6; attempt++) {
    if (await published(registry, name, version)) return true;
    if (attempt !== 5) await new Promise((resolve) => setTimeout(resolve, 1000 * 2 ** attempt));
  }
  return false;
}

/** Gate evidence names the immutable input and each actually completed command. */
interface GateType {
  readonly task: string;
  readonly started: string;
  readonly finished: string;
  readonly code: number;
  readonly source: string;
  readonly revision: string;
  readonly phase: "dependencies" | "source";
  readonly before: { source: string; revision: string };
  readonly logs?: { stdout: { file: string; sha256: string }; stderr: { file: string; sha256: string } };
}

/**
 * Prepares only from an owned checkout of a clean committed revision.
 *
 * Original working-tree edits cannot become build inputs, including edits later
 * restored to their original bytes. Source permissions prevent accidental writes;
 * identity checks remain authoritative. Cleanup must settle before a receipt is
 * issued, and independent operation/cleanup errors are retained together.
 */
async function prepareSnapshot(): Promise<{
  candidate: CandidateType;
  manifests: Record<string, string>;
}> {
  if (Deno.build.os === "windows") {
    throw new Error(
      "Release preparation does not support Windows source protection. Run release:prepare on an ordinary Unix account or the Unix CI runner. Consumer runtime support is unchanged.",
    );
  }
  // Unix root bypasses source permissions. Require an ordinary account so an
  // accidental gate write cannot change and restore maintained inputs unseen.
  if (process.getuid?.() === 0) {
    throw new Error(
      "Release preparation does not support Unix UID 0. Run release:prepare as an ordinary account; root bypasses immutable-source permissions.",
    );
  }
  await cleanRevision();
  const commit = await revision();
  const source = await sourceHash();
  const directory = await Deno.makeTempDir({ prefix: "release-snapshot-" });
  const snapshot = resolve(directory, "source");
  const failures: unknown[] = [];
  const frozen: Array<[string, number]> = [];
  const steps: GateType[] = [];
  const attempt = crypto.randomUUID();
  const evidence = `${STORE}/gates-${commit}-${attempt}.json`;
  const reportDirectory = `${STORE}/snapshot-${commit}-${attempt}/reports`;
  let reports: { path: string; source: string; revision: string } | undefined;
  let result: { candidate: CandidateType; manifests: Record<string, string> } | undefined;
  try {
    await run("git", ["clone", "--no-hardlinks", "--no-checkout", "--dissociate", "--", ROOT, snapshot]);
    await run("git", ["-c", "core.hooksPath=/dev/null", "checkout", "--detach", commit], snapshot);
    await verify();
    const members = await discoverPackages(snapshot, await loadConfig(snapshot));
    const dependencyGraph = new DependencyGraph(members);
    const opfs = members.has("@okikio/opfs");
    const dependencies = resolve(ROOT, "node_modules");
    let installed = false;
    try {
      await Deno.lstat(dependencies);
      installed = true;
    } catch (reason) {
      if (!(reason instanceof Deno.errors.NotFound)) throw reason;
    }
    if (installed) {
      const dependencyRoot = await Deno.realPath(dependencies);
      await copyTree(dependencyRoot, resolve(snapshot, "node_modules"), [
        [dependencyRoot, resolve(snapshot, "node_modules")],
        [ROOT, snapshot],
      ]);
    }
    await copySourceCache(resolve(directory, "deno-cache"));
    // Own output namespaces before protecting root directory entries. Cold
    // installs may fill node_modules; destructive replacement happens before freezing.
    for (const name of [".tmp", ".release", "node_modules"]) {
      await Deno.mkdir(resolve(snapshot, name), { recursive: true });
    }
    if (opfs) await dependenciesPhase();
    const parents = new Set<string>([snapshot]);
    for (const path of await sourcePaths(snapshot)) {
      const file = resolve(snapshot, path);
      const info = await Deno.lstat(file);
      if (info.isSymlink) throw new Error(`Maintained source aliases are unsupported: ${path}`);
      if (!info.isFile) throw new Error(`Maintained source is not a file: ${path}`);
      const mode = info.mode ?? 0o644;
      frozen.push([file, mode]);
      await Deno.chmod(file, mode & ~0o222);
      let parent = dirname(file);
      while (parent !== snapshot) {
        parents.add(parent);
        parent = dirname(parent);
      }
    }
    for (const path of [...parents].sort((left, right) => right.length - left.length)) {
      const mode = (await Deno.lstat(path)).mode ?? 0o755;
      frozen.push([path, mode]);
      await Deno.chmod(path, mode & ~0o222);
    }
    const tasks = opfs
      ? [
        "quality:source",
        "test",
        "test:node",
        "test:bun",
        "test:browser",
        "test:ecosystems",
        "test:providers",
        "test:linux",
        "bench:report",
        "bench:browser",
        "pack:npm",
        "verify:npm:artifact",
      ]
      : ["release-check"];
    for (const task of tasks) {
      await verify();
      const before = { source: await sourceHash(snapshot), revision: await revision(snapshot) };
      const started = new Date().toISOString();
      const status = await new Deno.Command(Deno.execPath(), {
        args: [
          "task",
          task,
          ...(task === "verify:npm:artifact" ? [archivePath(members.get("@okikio/opfs")!, opfs)] : []),
        ],
        cwd: snapshot,
        env: { DENO_DIR: resolve(directory, "deno-cache") },
        stdin: "inherit",
        stdout: "inherit",
        stderr: "inherit",
      }).spawn().status;
      const after = await sourceHash(snapshot);
      steps.push({
        task,
        started,
        finished: new Date().toISOString(),
        code: status.code,
        source: after,
        revision: await revision(snapshot),
        phase: "source",
        before,
      });
      await verify();
      if (!status.success) throw new Error(`Snapshot gate '${task}' failed with exit code ${status.code}.`);
    }
    const rows: CandidateType["packages"] = [];
    const manifests: Record<string, string> = {};
    for (const name of dependencyGraph.topologicalSort(members)) {
      const member = members.get(name)!;
      const archive = archivePath(member, opfs);
      rows.push({
        name,
        version: member.version,
        archive,
        sha256: await hash(await Deno.readFile(resolve(snapshot, archive))),
      });
      manifests[name] = await Deno.readTextFile(resolve(snapshot, member.dir, "package.json"));
    }
    await verify();
    await original();
    // Carry package receipts and report bytes with the archives. Never merge an
    // old artifact inventory into the newly checked snapshot's inventory.
    const artifactDirectory = opfs ? ".release/npm" : ".tmp/packages";
    const output = resolve(ROOT, artifactDirectory);
    await verify();
    try {
      await Deno.remove(output, { recursive: true });
    } catch (reason) {
      if (!(reason instanceof Deno.errors.NotFound)) throw reason;
    }
    await Deno.mkdir(output, { recursive: true });
    for (const row of rows) {
      await verify();
      await Deno.copyFile(resolve(snapshot, row.archive), resolve(ROOT, row.archive));
    }
    // Artifact inventory is an independent packing authority; retain it when
    // this package family emits one, without copying its staging/install trees.
    const receipt = resolve(snapshot, artifactDirectory, "artifacts.json");
    try {
      await Deno.copyFile(receipt, resolve(output, "artifacts.json"));
    } catch (reason) {
      if (!(reason instanceof Deno.errors.NotFound)) throw reason;
    }
    const reportSource = resolve(snapshot, ".tmp/reports");
    let hasReports = false;
    try {
      await Deno.lstat(reportSource);
      hasReports = true;
    } catch (reason) {
      if (!(reason instanceof Deno.errors.NotFound)) throw reason;
    }
    if (hasReports) {
      await verify();
      const target = resolve(ROOT, reportDirectory);
      await copyTree(reportSource, target, [[reportSource, target]]);
      reports = { path: reportDirectory, source, revision: commit };
    }
    for (const row of rows) {
      if (row.sha256 !== await hash(await Deno.readFile(resolve(ROOT, row.archive)))) {
        throw new Error(`Snapshot artifact copy changed: ${row.archive}`);
      }
    }
    result = {
      candidate: {
        source,
        revision: commit,
        created: new Date().toISOString(),
        gates: { file: evidence, sha256: "" },
        packages: rows,
      },
      manifests,
    };
  } catch (reason) {
    failures.push(reason);
  } finally {
    // Attempt cleanup even when a gate failed. Permission restoration and tree
    // removal failures remain separate from the primary operation failure.
    try {
      for (const [path, mode] of frozen.reverse()) {
        try {
          await Deno.chmod(path, mode);
        } catch (reason) {
          failures.push(reason);
        }
      }
      await Deno.remove(directory, { recursive: true });
      try {
        await Deno.lstat(directory);
        failures.push(new Error("Release snapshot survived cleanup."));
      } catch (reason) {
        if (!(reason instanceof Deno.errors.NotFound)) failures.push(reason);
      }
    } catch (reason) {
      failures.push(reason);
    }
    if (failures.length === 0) {
      try {
        await original();
      } catch (reason) {
        failures.push(reason);
      }
    }
    // A receipt saying passed must include successful owned cleanup. Do not
    // replace evidence from another attempt at this same immutable revision.
    try {
      await Deno.mkdir(STORE, { recursive: true });
      await save(evidence, {
        revision: commit,
        source,
        steps,
        ...(reports ? { reports } : {}),
        passed: result !== undefined && failures.length === 0,
        failures: failures.map((reason) => reason instanceof Error ? reason.message : String(reason)),
      });
    } catch (reason) {
      failures.push(reason);
    }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) {
    throw new AggregateError(failures, "Snapshot preparation and cleanup failed.", { cause: failures[0] });
  }
  if (!result) throw new Error("Snapshot preparation did not produce a candidate.");
  result.candidate.gates.sha256 = await hash(await Deno.readFile(evidence));
  return result;

  /** Installs the committed lock graph while its root entry may be replaced, before any source gate. */
  async function dependenciesPhase(): Promise<void> {
    await verify();
    await original();
    const before = { source: await sourceHash(snapshot), revision: await revision(snapshot) };
    const started = new Date().toISOString();
    const logs = `${STORE}/snapshot-${commit}-${attempt}/dependencies`;
    await Deno.mkdir(resolve(ROOT, logs), { recursive: true });
    const stdout = `${logs}/stdout.log`, stderr = `${logs}/stderr.log`;
    const files: Deno.FsFile[] = [];
    const errors: unknown[] = [];
    let status: Deno.CommandStatus | undefined;
    try {
      const out = await Deno.open(resolve(ROOT, stdout), { write: true, createNew: true });
      files.push(out);
      const err = await Deno.open(resolve(ROOT, stderr), { write: true, createNew: true });
      files.push(err);
      console.log("Snapshot dependency phase: deno task deps:ci (before source protection).");
      const child = new Deno.Command(Deno.execPath(), {
        args: ["task", "deps:ci"],
        cwd: snapshot,
        env: { DENO_DIR: resolve(directory, "deno-cache") },
        stdin: "inherit",
        stdout: "piped",
        stderr: "piped",
      }).spawn();
      const retain = async (stream: ReadableStream<Uint8Array>, file: Deno.FsFile): Promise<void> => {
        const reader = stream.getReader();
        const failures: unknown[] = [];
        let ended = false;
        try {
          // Write exact child bytes directly. FsFile writes can be shorter than
          // the supplied chunk; retain the remainder before reading more data.
          while (true) {
            const item = await reader.read();
            if (item.done) {
              ended = true;
              break;
            }
            let offset = 0;
            while (offset < item.value.length) {
              const remaining = item.value.subarray(offset);
              const written = await file.write(remaining);
              if (!Number.isInteger(written) || written <= 0 || written > remaining.length) {
                throw new Error("Dependency raw output writer made invalid progress.");
              }
              offset += written;
            }
          }
        } catch (reason) {
          failures.push(reason);
          // Stop this directly owned task CLI on logging failure. Its spawned
          // install descendants are not implied to share that lifetime; the
          // outer aggregate/container watchdog owns the final process boundary.
          try {
            child.kill("SIGKILL");
          } catch (stop) {
            if (!(stop instanceof Deno.errors.NotFound)) failures.push(stop);
          }
        } finally {
          if (!ended) {
            try {
              await reader.cancel();
            } catch (reason) {
              failures.push(reason);
            }
          }
          try {
            reader.releaseLock();
          } catch (reason) {
            failures.push(reason);
          }
        }
        if (failures.length === 1) throw failures[0];
        if (failures.length > 1) {
          throw new AggregateError(failures, "Dependency raw output and reader cleanup failed.", {
            cause: failures[0],
          });
        }
      };
      // Both raw streams settle alongside the actual status. A logging failure
      // cannot become successful dependency evidence or suppress another error.
      const outcomes = await Promise.allSettled(
        [
          child.status,
          retain(child.stdout, out),
          retain(child.stderr, err),
        ] as const,
      );
      const first = outcomes[0]!;
      if (first.status === "fulfilled") status = first.value;
      for (const outcome of outcomes) if (outcome.status === "rejected") errors.push(outcome.reason);
    } catch (reason) {
      errors.push(reason);
    } finally {
      for (const file of files) {
        try {
          file.close();
        } catch (reason) {
          errors.push(reason);
        }
      }
    }
    let recorded: GateType["logs"];
    try {
      recorded = {
        stdout: { file: stdout, sha256: await fileHash(resolve(ROOT, stdout)) },
        stderr: { file: stderr, sha256: await fileHash(resolve(ROOT, stderr)) },
      };
    } catch (reason) {
      errors.push(reason);
    }
    if (status) {
      steps.push({
        task: "deps:ci",
        phase: "dependencies",
        before,
        started,
        finished: new Date().toISOString(),
        code: status.code,
        source: await sourceHash(snapshot),
        revision: await revision(snapshot),
        ...(recorded ? { logs: recorded } : {}),
      });
    }
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) {
      throw new AggregateError(errors, "Dependency installation and raw evidence failed.", { cause: errors[0] });
    }
    await verify();
    await original();
    if (!status?.success) {
      throw new Error(
        `Snapshot dependency phase 'deps:ci' failed with exit code ${
          status?.code ?? "unreported"
        }. See ${stdout} and ${stderr}.`,
      );
    }
  }

  /** Checks identity after every gate, and before copying any release output. */
  async function verify(): Promise<void> {
    if (await revision(snapshot) !== commit || await sourceHash(snapshot) !== source) {
      throw new Error("Snapshot source or revision changed during release preparation.");
    }
  }
  /** Refuses a receipt when the caller retained an edit or changed branches. */
  async function original(): Promise<void> {
    await cleanRevision();
    if (await revision() !== commit || await sourceHash() !== source) {
      throw new Error("Original source or revision changed during snapshot preparation.");
    }
  }
}

/**
 * Copies independent bytes, rebasing only aliases inside the owned dependency
 * tree or committed workspace. External aliases reject instead of borrowing a
 * mutable checkout. No hard links are created.
 */
async function copyTree(
  source: string,
  destination: string,
  mappings: readonly (readonly [string, string])[],
): Promise<void> {
  const info = await Deno.lstat(source);
  if (info.isSymlink) {
    const target = await Deno.realPath(source);
    const mapping = mappings.find(([from]) =>
      target === from || target.startsWith(`${from}${Deno.build.os === "windows" ? "\\" : "/"}`)
    );
    if (!mapping) throw new Error(`Snapshot dependency alias escapes owned inputs: ${source}`);
    const mapped = resolve(mapping[1], relative(mapping[0], target));
    // Workspace source must actually exist in the committed clone. A link into
    // an ignored/uncommitted source directory is not a release dependency.
    if (mapping[0] === ROOT) await Deno.lstat(mapped);
    await Deno.mkdir(dirname(destination), { recursive: true });
    await Deno.symlink(relative(dirname(destination), mapped), destination, {
      type: (await Deno.stat(source)).isDirectory ? "dir" : "file",
    });
  } else if (info.isDirectory) {
    await Deno.mkdir(destination, { recursive: true });
    for await (const child of Deno.readDir(source)) {
      await copyTree(resolve(source, child.name), resolve(destination, child.name), mappings);
    }
  } else if (info.isFile) {
    await Deno.mkdir(dirname(destination), { recursive: true });
    await Deno.copyFile(source, destination);
    if (Deno.build.os !== "windows" && info.mode !== null) await Deno.chmod(destination, info.mode);
  } else throw new Error(`Unsupported snapshot input: ${source}`);
}

/** Enumerates maintained files; Git's ignore authority excludes task-owned outputs. */
async function sourcePaths(cwd: string): Promise<string[]> {
  const output = await new Deno.Command("git", {
    args: ["-c", "core.fsmonitor=false", "ls-files", "-z", "--cached", "--others", "--exclude-standard"],
    cwd,
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (!output.success) throw new Error("Cannot enumerate release source inputs.");
  return [...new Set(new TextDecoder().decode(output.stdout).split("\0").filter(Boolean))].sort();
}

/** Seeds an owned cache with downloaded source/metadata, never compiler state or databases. */
async function copySourceCache(destination: string): Promise<void> {
  const result = await new Deno.Command(Deno.execPath(), {
    args: ["info", "--json"],
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (!result.success) throw new Error("Cannot locate downloaded Deno source cache.");
  const info = JSON.parse(new TextDecoder().decode(result.stdout)) as { denoDir: string };
  await Deno.mkdir(destination, { recursive: true });
  for (const name of ["remote", "registries", "jsr"]) {
    const source = resolve(info.denoDir, name), target = resolve(destination, name);
    try {
      await Deno.lstat(source);
    } catch (reason) {
      if (reason instanceof Deno.errors.NotFound) continue;
      throw reason;
    }
    await copyTree(source, target, [[source, target]]);
  }
}
