/** Copies admitted source and installed dependencies without exposing the checkout to Docker. */
import { execFile } from "node:child_process";
import { createReadStream, createWriteStream } from "node:fs";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  statfs,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { createRequire } from "node:module";
import { finished, pipeline } from "node:stream/promises";
import { tmpdir } from "node:os";
import { constants } from "node:fs";
import { catalog, locate } from "./container-worker.mjs";

/** Outputs and repository administration are never admitted, even if tracked accidentally. */
export const omitted = new Set([
  ".git",
  ".hg",
  ".svn",
  ".tmp",
  ".release",
  ".agents",
  ".coverage",
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

/** Installed dist/build trees are runtime inputs, unlike checkout outputs. */
const administration = new Set([".git", ".hg", ".svn", ".tmp", ".release", ".agents", ".coverage"]);

/** Uses a bounded CLI lifetime; consumers can supply their already-owned cancellation boundary. */
function command(name, args, timeout) {
  return new Promise((accept, reject) => {
    execFile(name, args, { timeout, killSignal: "SIGKILL", maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) reject(new Error(`${name} failed: ${stderr}`, { cause: error }));
      else accept(stdout);
    });
  });
}

/** Hashes one file at a time with bounded buffers rather than retaining dependency bytes. */
export async function digest(path) {
  const hash = createHash("sha256");
  for await (const bytes of createReadStream(path, { highWaterMark: 64 * 1024 })) hash.update(bytes);
  return hash.digest("hex");
}

/**
 * Captures private-root authority before callers can use its paths.
 *
 * Cleanup never restores permissions or enumerates borrowed descendants. Host
 * staging stays owner-writable; Linux permissions belong to archive admission.
 * Canonical root and ancestor identity reject moved/replaced roots and parent
 * aliases before native recursive removal. Native file IDs are compared where
 * observable; Windows metadata never becomes a POSIX ownership claim. These
 * observations do not provide an atomic hostile concurrent-filesystem boundary.
 */
export async function own(directory) {
  const original = resolve(directory);
  if (!(await lstat(original)).isDirectory() || (await lstat(original)).isSymbolicLink()) {
    throw new Error("Private container staging must be a physical directory.");
  }
  const canonical = await locate(original);
  const observations = [];
  const identity = (info) => ({
    directory: info.isDirectory(),
    alias: info.isSymbolicLink(),
    dev: process.platform === "win32" && info.ino <= 0n ? null : String(info.dev),
    ino: process.platform === "win32" && info.ino <= 0n ? null : String(info.ino),
    uid: process.platform === "win32" ? null : String(info.uid),
    gid: process.platform === "win32" ? null : String(info.gid),
  });
  for (let path = canonical;; path = dirname(path)) {
    const info = await lstat(path, { bigint: true });
    if (process.platform !== "win32" && (info.ino <= 0n || info.dev < 0n)) {
      throw new Error(`Private staging native identity is unavailable: ${path}`);
    }
    const observed = identity(info);
    if (!observed.directory || observed.alias) throw new Error("Private staging ancestor is not physical.");
    observations.push([path, observed]);
    if (dirname(path) === path) break;
  }
  const verify = async () => {
    const root = await lstat(original);
    const actualRoot = { directory: root.isDirectory(), alias: root.isSymbolicLink() };
    if (!actualRoot.directory || actualRoot.alias) {
      throw new Error("Private container root or parent alias changed.", {
        cause: { path: original, expected: { directory: true, alias: false }, actual: actualRoot },
      });
    }
    const actualCanonical = await locate(original);
    if (actualCanonical !== canonical) {
      throw new Error("Private container canonical root changed.", {
        cause: { path: original, expectedCanonical: canonical, actualCanonical },
      });
    }
    for (const [path, observed] of observations) {
      const actual = identity(await lstat(path, { bigint: true }));
      if (JSON.stringify(actual) !== JSON.stringify(observed)) {
        throw new Error(`Private container root or ancestor identity changed: ${path}`, {
          cause: { path, expected: observed, actual },
        });
      }
      const actualCanonical = await locate(path);
      if (actualCanonical !== path) {
        throw new Error(`Private container canonical ancestor changed: ${path}`, {
          cause: { path, expectedCanonical: path, actualCanonical },
        });
      }
    }
  };
  await verify();
  let closing;
  return {
    directory: canonical,
    identity: { original, canonical, observations },
    verify,
    close: () =>
      closing ??= (async () => {
        await verify();
        // rm removes leaf aliases rather than recursively acquiring their targets.
        // No chmod traversal is needed for the owner-writable private host copy.
        await rm(canonical, { recursive: true });
      })(),
  };
}

/** True only for physical descendants; lexical prefix matches cannot admit a sibling directory. */
function inside(root, path) {
  const name = relative(root, path);
  return name === "" || (!isAbsolute(name) && name !== ".." && !name.startsWith(`..${sep}`));
}

/**
 * Copies a tree serially, preserving observed POSIX executable bits and contained aliases.
 *
 * Real files use copyFile, never a shared hard link. Alias targets must resolve
 * within an admitted mapping; absolute installed aliases become relative links
 * into the owned copy. Windows host modes are not permission authority.
 * Special files and escaped/broken/cyclic aliases reject.
 * Physical directories are reinspected, so an alias is never recursively followed.
 */
export async function copy(source, target, mappings, selected, signal, excluded = omitted) {
  signal?.throwIfAborted();
  const info = await lstat(source);
  if (info.isSymbolicLink()) {
    const resolved = await locate(source);
    const mapping = mappings.filter(([root]) => inside(root, resolved)).sort(([a], [b]) => b.length - a.length)[0];
    if (!mapping) throw new Error(`Container input alias escapes admitted trees: ${source}`);
    const destination = resolve(mapping[1], relative(mapping[0], resolved));
    await mkdir(dirname(target), { recursive: true });
    const directory = (await lstat(resolved)).isDirectory();
    try {
      // Windows junctions avoid directory-symlink privileges. Archive headers
      // later use contained relative Linux aliases, never junction spellings.
      await symlink(
        process.platform === "win32" && directory ? destination : relative(dirname(target), destination),
        target,
        process.platform === "win32" ? directory ? "junction" : "file" : undefined,
      );
    } catch (cause) {
      if (process.platform === "win32" && !directory) {
        throw new Error("Windows container inputs with file aliases require Developer Mode or symlink privilege.", {
          cause,
        });
      }
      throw cause;
    }
  } else if (info.isDirectory()) {
    await mkdir(target, { recursive: true, mode: 0o700 });
    for (const name of (await readdir(source)).sort()) {
      if (excluded.has(name)) continue;
      if (selected && !selected.has(resolve(source, name))) continue;
      await copy(join(source, name), join(target, name), mappings, selected, signal, excluded);
    }
    if (process.platform !== "win32") await chmod(target, 0o700);
  } else if (info.isFile()) {
    await mkdir(dirname(target), { recursive: true });
    await copyFile(source, target, constants.COPYFILE_EXCL);
    await chmod(target, process.platform === "win32" ? 0o600 : info.mode & 0o111 ? 0o700 : 0o600);
  } else throw new Error(`Container input must be a file, directory or contained alias: ${source}`);
}

/**
 * Emits explicit portable headers; native Windows junction spellings never enter tar.
 *
 * Archiver is resolved lazily through Testcontainers' locked dependency. Each
 * file stream settles before the next is acquired; supplying Stats keeps tar's
 * stream path bounded instead of its whole-body collection fallback. Deadline
 * and cancellation destroy the current source and both transport sides before
 * temporary-directory removal. Finalization and writer failures remain evidence.
 */
export async function pack(tree, manifest, target, { signal, timeout = 180_000 } = {}) {
  signal?.throwIfAborted();
  const require = createRequire(import.meta.url);
  const parent = createRequire(require.resolve("testcontainers"));
  const entry = parent.resolve("archiver");
  const metadata = JSON.parse(await readFile(parent.resolve("archiver/package.json"), "utf8"));
  const authority = { name: metadata.name, version: metadata.version, entry, entrySha256: await digest(entry) };
  const archive = parent("archiver")("tar", { statConcurrency: 1 });
  const writer = createWriteStream(target, { flags: "wx", mode: 0o600 });
  const control = new AbortController();
  const failures = [];
  const retain = (reason) => {
    if (!failures.includes(reason)) failures.push(reason);
  };
  let active;
  let rejectTerminal;
  const terminal = new Promise((_, reject) => {
    rejectTerminal = reject;
  });
  // Every rejecting task receives a handler before any source is admitted.
  terminal.catch(() => {});
  const stop = (reason) => {
    retain(reason);
    if (!control.signal.aborted) {
      control.abort(reason);
      rejectTerminal(reason);
      const error = reason instanceof Error ? reason : new Error("Archive cancelled.", { cause: reason });
      active?.destroy(error);
      archive.abort();
      archive.destroy(error);
      writer.destroy(error);
    }
  };
  const abort = () => stop(signal.reason);
  signal?.addEventListener("abort", abort, { once: true });
  archive.on("warning", stop);
  archive.on("error", stop);
  writer.on("error", stop);
  const timer = setTimeout(() => stop(new Error("Container archive operational deadline expired.")), timeout);
  const transport = pipeline(archive, writer, { signal: control.signal }).catch((reason) => {
    stop(reason);
    throw reason;
  });
  transport.catch(() => {});
  let finalization;
  try {
    if (signal?.aborted) stop(signal.reason);
    for (
      const [name, value] of [
        ["manifest.json", { kind: "file", mode: 0o444 }],
        ...Object.entries(manifest.entries),
      ]
    ) {
      signal?.throwIfAborted();
      if (control.signal.aborted) throw control.signal.reason;
      let resolveEntry;
      const completed = new Promise((accept) => {
        resolveEntry = accept;
      });
      const onEntry = () => resolveEntry();
      archive.once("entry", onEntry);
      let sourceSettlement;
      try {
        const header = { name, mode: value.mode, uid: 0, gid: 0, date: new Date(0) };
        if (value.kind === "directory") archive.append(Buffer.alloc(0), { ...header, type: "directory" });
        else if (value.kind === "link") {
          archive.append(Buffer.alloc(0), { ...header, type: "symlink", linkname: value.target });
        } else {
          const path = join(tree, name), stats = await lstat(path);
          active = createReadStream(path, { highWaterMark: 64 * 1024 });
          active.on("error", stop);
          sourceSettlement = finished(active, { cleanup: true });
          sourceSettlement.catch(() => {});
          archive.append(active, { ...header, stats });
        }
        await Promise.race([completed, terminal]);
        if (sourceSettlement) await sourceSettlement;
      } finally {
        archive.removeListener("entry", onEntry);
        if (sourceSettlement) {
          if (control.signal.aborted) {
            active.destroy(new Error("Archive source cancelled.", { cause: control.signal.reason }));
          }
          const outcome = await Promise.allSettled([sourceSettlement]);
          for (const item of outcome) if (item.status === "rejected") retain(item.reason);
        }
        active = undefined;
      }
    }
    finalization = Promise.race([archive.finalize(), terminal]);
    finalization.catch(() => {});
    await Promise.all([finalization, transport]);
  } catch (reason) {
    stop(reason);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
    const outcomes = await Promise.allSettled([transport, ...(finalization ? [finalization] : [])]);
    for (const item of outcomes) if (item.status === "rejected") retain(item.reason);
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length) {
    throw new AggregateError(failures, "Container archive and owned stream cleanup failed.", { cause: failures[0] });
  }
  return authority;
}

/** Retains bounded actual differences while complete catalog digests bind every observed entry. */
export function changes(before, after) {
  const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
  const scopes = { source: 0, dependencies: 0, cache: 0 };
  const differences = [];
  let count = 0;
  for (const path of new Set([...Object.keys(before.entries), ...Object.keys(after.entries)])) {
    const previous = before.entries[path], current = after.entries[path];
    if (JSON.stringify(previous) === JSON.stringify(current)) continue;
    const scope = (path === "deno-cache" || path.startsWith("deno-cache/"))
      ? "cache"
      : (path === "source/node_modules" || path.startsWith("source/node_modules/"))
      ? "dependencies"
      : "source";
    scopes[scope]++;
    count++;
    if (differences.length < 32) differences.push({ path, scope, before: previous ?? null, after: current ?? null });
  }
  const previousPaths = new Set(before.paths), currentPaths = new Set(after.paths);
  const added = [...currentPaths].filter((path) => !previousPaths.has(path));
  const removed = [...previousPaths].filter((path) => !currentPaths.has(path));
  return {
    beforeSha256: hash(before),
    afterSha256: hash(after),
    root: { before: before.root, after: after.root },
    sourceMembership: {
      addedCount: added.length,
      removedCount: removed.length,
      added: added.slice(0, 32),
      removed: removed.slice(0, 32),
    },
    changedEntries: count,
    scopes,
    differences,
    omittedDifferences: Math.max(0, count - differences.length),
  };
}

/** Builds all canonical source parents without enumerating ignored checkout trees. */
async function sourcePaths(root, run) {
  const output = await run("git", [
    "-c",
    "core.fsmonitor=false",
    "-C",
    root,
    "ls-files",
    "-z",
    "--cached",
    "--others",
    "--exclude-standard",
  ], 30_000);
  const paths = new Set([root]);
  for (const name of output.split("\0").filter(Boolean)) {
    if (isAbsolute(name) || name.split(/[\\/]/u).includes("..")) {
      throw new Error(`Invalid canonical source path: ${name}`);
    }
    if (name.split("/").some((part) => omitted.has(part)) || name.startsWith("node_modules/")) continue;
    let path = resolve(root, name);
    paths.add(path);
    while (path !== root) {
      path = dirname(path);
      paths.add(path);
    }
  }
  for (const name of ["mod.ts", "deno.json", "deno.lock", "package.json", ".mise/tasks/container-worker.mjs"]) {
    if (!paths.has(resolve(root, name))) throw new Error(`Required container source is absent: ${name}`);
    if (!(await lstat(resolve(root, name))).isFile()) {
      throw new Error(`Required container source is not a regular file: ${name}`);
    }
  }
  return paths;
}

/**
 * Owns one complete identity-guarded copy and archive for all lanes in an invocation.
 *
 * Git is consulted only in the ordinary outer checkout. Docker receives no Git
 * directory, host-source bind, hard link or escaped alias. Complete source,
 * dependency and optional manual Deno cache catalogs are compared before copy,
 * after copy and after workloads. Disk work scales with the admitted graph:
 * one copied tree plus an uncompressed archive; no file bytes are buffered whole.
 * Archive creation has a three-minute operational deadline, not a performance budget.
 */
export async function open(root = process.cwd(), { cache, run = command, signal, temporary = tmpdir() } = {}) {
  signal?.throwIfAborted();
  if ((await lstat(root)).isSymbolicLink()) throw new Error("Container source root cannot be an alias.");
  root = await locate(root);
  const dependency = await locate(join(root, "node_modules"));
  if (dependency !== join(root, "node_modules")) throw new Error("Installed node_modules root cannot be an alias.");
  if (cache) cache = await locate(cache);
  const created = await mkdtemp(join(temporary, "opfs-container-"));
  let ownership;
  try {
    ownership = await own(created);
  } catch (reason) {
    // A created pathname is not sufficient cleanup authority after identity
    // acquisition fails. Retain it for recovery, never guess a borrowed target.
    throw new Error("Private staging cleanup authority could not be acquired.", {
      cause: { created, reason, cleanup: "not attempted without acquired native path authority" },
    });
  }
  const { directory, close } = ownership;
  const tree = join(directory, "tree");
  try {
    await ownership.verify();
    await mkdir(tree, { mode: 0o700 });
    const selected = await sourcePaths(root, run);
    const mappings = [[root, join(tree, "source")], [dependency, join(tree, "source/node_modules")]];
    if (cache) mappings.push([cache, join(tree, "deno-cache")]);
    const roots = ["source", ...(cache ? ["deno-cache"] : [])];
    const host = async () => {
      const current = await sourcePaths(root, run);
      const result = await catalog(root, {
        selected: current,
        omit: [...omitted],
        prefix: "source",
        originalModes: true,
        ownership: true,
      });
      Object.assign(
        result,
        await catalog(dependency, {
          omit: [...administration],
          prefix: "source/node_modules",
          originalModes: true,
          ownership: true,
        }),
      );
      if (cache) {
        Object.assign(
          result,
          await catalog(cache, {
            omit: [...administration],
            prefix: "deno-cache",
            originalModes: true,
            ownership: true,
          }),
        );
      }
      const physical = await lstat(root);
      return {
        paths: [...current].map((path) => relative(root, path)).sort(),
        root: process.platform === "win32"
          ? { uid: null, gid: null, mode: null }
          : { uid: physical.uid, gid: physical.gid, mode: physical.mode & 0o777 },
        entries: result,
      };
    };
    const before = await host();
    const hostCatalogSha256 = createHash("sha256").update(JSON.stringify(before)).digest("hex");
    const capacity = await statfs(directory);
    // Account conservatively for copied filesystem blocks, an uncompressed
    // archive and headers. A concurrent disk user can still consume this space.
    const copyBytes = Object.values(before.entries).reduce(
      (sum, entry) => sum + (entry.bytes === undefined ? 0 : Math.ceil(entry.bytes / capacity.bsize) * capacity.bsize),
      0,
    );
    const requiredBytes = 2 * copyBytes + Object.keys(before.entries).length * 4096;
    const availableBytes = capacity.bavail * capacity.bsize;
    if (availableBytes < requiredBytes) {
      throw new Error("Insufficient private temporary disk headroom for container copy and archive.");
    }
    const admitted = new Set(
      Object.keys(before.entries).map((name) =>
        name.startsWith("deno-cache")
          ? resolve(cache, name.slice("deno-cache".length + 1))
          : resolve(root, name.slice("source".length + 1))
      ),
    );
    // Reserve the separately admitted dependency child before source copying.
    await mkdir(join(tree, "source/node_modules"), { recursive: true });
    await copy(root, join(tree, "source"), mappings, selected, signal);
    await copy(dependency, join(tree, "source/node_modules"), mappings, admitted, signal, administration);
    if (cache) await copy(cache, join(tree, "deno-cache"), mappings, admitted, signal, administration);
    // Copy may expose a missing alias target excluded by the canonical catalog.
    const stage = async () => {
      const result = {};
      for (const name of roots) {
        Object.assign(result, await catalog(join(tree, name), { prefix: name, aliases: tree, originalModes: true }));
      }
      return result;
    };
    const staged = await stage();
    // Host observations may be unknown on Windows. The portable declaration
    // is a separate Linux authority, established by its private --admit worker.
    const entries = structuredClone(staged);
    for (const [name, value] of Object.entries(entries)) {
      value.mode = value.kind === "directory"
        ? 0o555
        : value.kind === "link"
        ? 0o777
        : value.mode & 0o111
        ? 0o555
        : 0o444;
      if (value.kind === "file") value.links = 1;
      if (value.kind === "link") {
        value.target = relative(dirname(join(tree, name)), await locate(join(tree, name))).split(sep).join("/");
      }
    }
    const manifest = { version: 1, roots, entries };
    const manifestBytes = JSON.stringify(manifest);
    await writeFile(join(tree, "manifest.json"), manifestBytes, process.platform === "win32" ? {} : { mode: 0o600 });
    const after = await host();
    if (JSON.stringify(before) !== JSON.stringify(after)) {
      throw new Error("Container inputs changed while being copied.", { cause: changes(before, after) });
    }
    // Files in the copy must match host digests; aliases deliberately have rebased spellings.
    for (const [name, value] of Object.entries(before.entries)) {
      if (value.kind === "file" && entries[name]?.sha256 !== value.sha256) {
        throw new Error(`Copied input bytes differ: ${name}`);
      }
      if (entries[name]?.kind !== value.kind) throw new Error(`Copied input kind differs: ${name}`);
      if (value.kind === "link") {
        const mapping = mappings.filter(([base]) => inside(base, value.resolved))
          .sort(([a], [b]) => b.length - a.length)[0];
        if (!mapping) throw new Error(`Original alias escaped admitted inputs: ${name}`);
        const expected = resolve(mapping[1], relative(mapping[0], value.resolved));
        if (await locate(join(tree, name)) !== expected) throw new Error(`Copied alias target differs: ${name}`);
      }
    }
    await ownership.verify();
    const archive = join(directory, "inputs.tar");
    const archiveAuthority = await pack(tree, manifest, archive, { signal });
    const archiveSha256 = await digest(archive);
    const bytes = Object.values(entries).reduce((sum, entry) => sum + (entry.bytes ?? 0), 0);
    return {
      directory,
      archive,
      archiveSha256,
      manifest,
      receipt: {
        version: 1,
        archiveSha256,
        hostCatalogSha256,
        workerSha256: entries["source/.mise/tasks/container-worker.mjs"].sha256,
        paths: Object.keys(entries).length,
        fileBytes: bytes,
        diskHeadroom: { requiredBytes, availableBytes, scope: "setup estimate; concurrent disk use is uncontrolled" },
        archiveAuthority,
        hostPlatform: process.platform,
        stagingIdentity: ownership.identity,
        hostProtection: process.platform === "win32"
          ? "byte/alias identity; POSIX metadata unknown"
          : "owner-writable private staging; native identity guarded",
        cacheIncluded: Boolean(cache),
        sourceOwner: before.root,
        transport: "owned archive; no checkout bind or hard links",
        entries,
      },
      async verify() {
        await ownership.verify();
        const current = await host();
        if (JSON.stringify(before) !== JSON.stringify(current)) {
          throw new Error("Outer container source, dependencies or cache changed.", {
            cause: changes(before, current),
          });
        }
        if (JSON.stringify(staged) !== JSON.stringify(await stage())) throw new Error("Owned host copy changed.");
        if (await readFile(join(tree, "manifest.json"), "utf8") !== manifestBytes) {
          throw new Error("Owned manifest changed.");
        }
        if (await digest(archive) !== archiveSha256) throw new Error("Container archive changed.");
        return { status: "unchanged", hostCatalogSha256, archiveSha256 };
      },
      close,
    };
  } catch (error) {
    try {
      await close();
    } catch (cleanup) {
      throw new AggregateError([error, cleanup], "Container admission and cleanup failed.", { cause: error });
    }
    throw error;
  }
}
