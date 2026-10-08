/** One native-JavaScript verifier runs on Node, Bun and Deno; no compiler or Git is needed in the image. */
import { createReadStream, realpath } from "node:fs";
import { chmod, lstat, readdir, readFile, readlink } from "node:fs/promises";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import process from "node:process";

/**
 * Resolves one absolute native filesystem identity before containment comparisons.
 *
 * Use the documented native API on every runtime. A drive-relative result such
 * as C: would resolve against a per-drive working directory and cannot establish
 * root or alias authority. Do not repair it by appending a separator or by
 * dropping the volume-root check.
 *
 * @param {string} path Input filesystem path.
 * @returns {Promise<string>} Absolute native canonical path.
 */
export function locate(path) {
  return new Promise((accept, reject) => {
    realpath.native(path, { encoding: "utf8" }, (error, canonical) => {
      if (error) reject(error);
      else if (!isAbsolute(canonical)) {
        reject(new Error("Native container canonical path must be absolute.", { cause: { path, canonical } }));
      } else accept(canonical);
    });
  });
}

/** Traverses physical children, hashes one regular file at a time, and never follows directory aliases. */
export async function catalog(
  root,
  { selected, omit = [], prefix = "", aliases, originalModes = false, owner, ownership = false } = {},
) {
  const excluded = new Set(omit);
  const entries = {};
  const windows = process.platform === "win32";
  async function visit(path, name) {
    const info = await lstat(path);
    if (owner !== undefined && (info.uid !== owner || info.gid !== owner)) {
      throw new Error(`Container source owner differs: ${name}`);
    }
    if (info.isSymbolicLink()) {
      if (aliases) {
        const target = await locate(path);
        const suffix = relative(aliases, target);
        if (isAbsolute(suffix) || suffix === ".." || suffix.startsWith(`..${sep}`)) {
          throw new Error(`Container alias escapes copy: ${name}`);
        }
      }
      // Linux aliases have fixed 0777 permissions; their target owns access.
      // Keep host-native modes in the outer catalog, but normalize owned link
      // metadata so a Darwin archive does not claim portable link chmod semantics.
      entries[name] = {
        kind: "link",
        mode: windows ? null : aliases ? 0o777 : info.mode & 0o777,
        target: await readlink(path),
      };
    } else if (info.isDirectory()) {
      entries[name] = { kind: "directory", mode: windows ? null : originalModes ? info.mode & 0o777 : 0o555 };
      for (const child of (await readdir(path)).sort()) {
        if (excluded.has(child) || (selected && !selected.has(resolve(path, child)))) continue;
        await visit(join(path, child), name ? `${name}/${child}` : child);
      }
    } else if (info.isFile()) {
      if (aliases && (!windows || info.nlink > 0) && info.nlink !== 1) {
        throw new Error(`Owned container file shares hard-link storage: ${name}`);
      }
      const hash = createHash("sha256");
      for await (const bytes of createReadStream(path, { highWaterMark: 64 * 1024 })) hash.update(bytes);
      entries[name] = {
        kind: "file",
        mode: windows ? null : originalModes ? info.mode & 0o777 : info.mode & 0o111 ? 0o555 : 0o444,
        links: windows && info.nlink <= 0 ? null : info.nlink,
        bytes: info.size,
        sha256: hash.digest("hex"),
      };
    } else throw new Error(`Unsupported container input kind: ${name}`);
    if (ownership) {
      if (info.isSymbolicLink()) entries[name].resolved = await locate(path);
      Object.assign(entries[name], { uid: windows ? null : info.uid, gid: windows ? null : info.gid });
    }
  }
  await visit(root, prefix);
  return entries;
}

/** Exact membership, kind, permissions, bytes and alias spellings all belong to admission authority. */
export async function verify(root, manifest, { owner, permissions = true } = {}) {
  if (manifest.version !== 1 || !Array.isArray(manifest.roots)) throw new Error("Invalid container input manifest.");
  const entries = {};
  for (const name of manifest.roots) {
    if (!["source", "deno-cache"].includes(name)) throw new Error("Unexpected container input root.");
    Object.assign(
      entries,
      await catalog(join(root, name), { prefix: name, aliases: root, originalModes: true, owner }),
    );
  }
  const expected = structuredClone(manifest.entries);
  if (!permissions) {
    // Root admission may establish modes only after byte/kind/link identity is proved.
    for (const value of Object.values(entries)) delete value.mode;
    for (const value of Object.values(expected)) delete value.mode;
  }
  if (JSON.stringify(entries) !== JSON.stringify(expected)) {
    throw new Error("Container input tree differs from its exact admission manifest.");
  }
}

/** Runs only the explicit native command, then checks owned bytes even when that command fails. */
async function main() {
  const [directory, ...command] = process.argv.slice(2);
  if (!directory || !command.length) {
    throw new Error("Container worker requires its input root and explicit runtime command.");
  }
  const manifest = JSON.parse(await readFile(join(directory, "manifest.json"), "utf8"));
  if (command.length === 1 && command[0] === "--admit") {
    if (process.getuid?.() !== 0 || process.getgid?.() !== 0) {
      throw new Error("Private Linux mode admission requires root inside its owned copy.");
    }
    await verify(directory, manifest, { owner: 0, permissions: false });
    for (const [name, value] of Object.entries(manifest.entries).reverse()) {
      if (value.kind !== "link") await chmod(join(directory, name), value.mode);
    }
    await chmod(join(directory, "manifest.json"), 0o444);
  }
  const declaration = await lstat(join(directory, "manifest.json"));
  if (!declaration.isFile() || declaration.uid !== 0 || declaration.gid !== 0 || (declaration.mode & 0o777) !== 0o444) {
    throw new Error("Private Linux manifest must be a root-owned readonly regular file.");
  }
  await verify(directory, manifest, { owner: 0 });
  console.log(
    JSON.stringify({
      phase: "source-before",
      files: Object.keys(manifest.entries).length,
      uid: process.getuid?.(),
      runtime: process.versions,
    }),
  );
  if (command.length === 1 && ["--verify", "--admit"].includes(command[0])) return;
  if (process.getuid?.() !== 1000 || process.getgid?.() !== 1000) {
    throw new Error("Linux test command must run as ordinary UID/GID 1000.");
  }
  const status = await readFile("/proc/self/status", "utf8");
  for (const field of ["CapEff", "CapPrm", "CapAmb"]) {
    if (!new RegExp(`^${field}:\\s*0+$`, "m").test(status)) {
      throw new Error(`Ordinary Linux test command retains ${field} capabilities.`);
    }
  }
  const failures = [];
  try {
    const exit = await new Promise((accept, reject) => {
      const child = spawn(command[0], command.slice(1), { cwd: join(directory, "source"), stdio: "inherit" });
      child.once("error", reject);
      child.once(
        "close",
        (code, signal) =>
          code === 0 ? accept(code) : reject(new Error(`Container command exited ${code}, signal ${signal}.`)),
      );
    });
    console.log(JSON.stringify({ phase: "command", exit }));
  } catch (error) {
    failures.push(error);
  }
  try {
    await verify(directory, manifest, { owner: 0 });
    console.log(JSON.stringify({ phase: "source-after", status: "unchanged" }));
  } catch (error) {
    failures.push(error);
  }
  if (failures.length) {
    throw new AggregateError(failures, "Container command or source guard failed.", { cause: failures[0] });
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
