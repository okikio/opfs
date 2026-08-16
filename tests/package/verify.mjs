import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";

const tarball = resolve(process.argv[2] ?? "");
if (!tarball) throw new Error("Pass the npm tarball path.");

/** Runs one child command and rejects when it exits unsuccessfully. */
function command(file, args, options = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(file, args, { stdio: "inherit", ...options });
    child.on("error", reject);
    child.on("exit", (code) => code === 0
      ? resolvePromise()
      : reject(new Error(`${file} exited with ${code}.`)));
  });
}

/** Returns true when the executable can be started in this environment. */
async function hasCommand(file) {
  try {
    await command(file, ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/** Lists every regular file below one extracted package directory. */
async function walk(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await walk(path));
    else files.push(path);
  }
  return files;
}

const workspace = await mkdtemp(join(tmpdir(), "okikio-opfs-package-"));
try {
  const extracted = join(workspace, "extracted");
  await command("mkdir", ["-p", extracted]);
  await command("tar", ["-xzf", tarball, "-C", extracted]);
  const packageRoot = join(extracted, "package");
  const manifest = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));

  if (manifest.name !== "@okikio/opfs") throw new Error(`Unexpected npm package name: ${manifest.name}`);
  if (manifest.dependencies?.["drizzle-orm"]) throw new Error("drizzle-orm must not be a normal npm dependency.");
  if (!manifest.peerDependencies?.["drizzle-orm"]) throw new Error("drizzle-orm optional peer is missing.");
  if (manifest.peerDependenciesMeta?.["drizzle-orm"]?.optional !== true) {
    throw new Error("drizzle-orm must be marked as an optional peer.");
  }
  if (!manifest.dependencies?.zod) throw new Error("zod runtime dependency is missing.");

  for (const [subpath, target] of Object.entries(manifest.exports ?? {})) {
    const entry = typeof target === "string" ? { default: target } : target;
    for (const field of ["types", "import", "default"]) {
      const path = entry?.[field];
      if (path === undefined) continue;
      if (field === "types" && !path.endsWith(".d.ts")) {
        throw new Error(`${subpath} types do not point to .d.ts: ${path}`);
      }
      if (field !== "types" && !path.endsWith(".js")) {
        throw new Error(`${subpath} runtime does not point to .js: ${path}`);
      }
      await stat(join(packageRoot, path));
    }
  }

  const publishedFiles = await walk(packageRoot);
  const rawTs = publishedFiles.filter((path) => path.endsWith(".ts") && !path.endsWith(".d.ts"));
  if (rawTs.length > 0) throw new Error(`npm tarball contains raw TypeScript: ${rawTs.join(", ")}`);

  const consumer = join(workspace, "consumer");
  await command("mkdir", ["-p", consumer]);
  await writeFile(join(consumer, "package.json"), `${JSON.stringify({ private: true, type: "module" }, null, 2)}\n`);
  await command("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", tarball], { cwd: consumer });

  await writeFile(join(consumer, "smoke.mjs"), `
import { createFileSystem } from '@okikio/opfs';
import { createMemoryAdapter } from '@okikio/opfs/adapter/memory';
import { normalizePath } from '@okikio/opfs/path';
const fileSystem = createFileSystem(createMemoryAdapter(), { coordination: 'local' });
await fileSystem.writeFile('/smoke.txt', 'ok', { parents: true });
if (await fileSystem.readText('/smoke.txt') !== 'ok') throw new Error('npm memory adapter smoke failed');
if (normalizePath('a/../b') !== '/b') throw new Error('npm path smoke failed');
await import('@okikio/opfs/adapter/node');
await import('@okikio/opfs/adapter/deno');
await import('@okikio/opfs/adapter/bun');
`);
  await command("node", ["smoke.mjs"], { cwd: consumer });

  const hasDeno = await hasCommand("deno");
  const hasBun = await hasCommand("bun");
  if (hasDeno) await command("deno", ["run", "--node-modules-dir=manual", "smoke.mjs"], { cwd: consumer });
  if (hasBun) await command("bun", ["smoke.mjs"], { cwd: consumer });

  await writeFile(join(consumer, "consumer.ts"), `
import { createFileSystem, type FileSystemType } from '@okikio/opfs';
import { createMemoryAdapter } from '@okikio/opfs/adapter/memory';
const fileSystem: FileSystemType = createFileSystem(createMemoryAdapter());
await fileSystem.writeFile('/types.txt', 'ok', { parents: true });
`);
  if (hasDeno) await command("deno", ["check", "--node-modules-dir=manual", "consumer.ts"], { cwd: consumer });

  await writeFile(join(consumer, "browser.mjs"), `
import { createFileSystem } from '@okikio/opfs';
import { createMemoryAdapter } from '@okikio/opfs/adapter/memory';
import { normalizePath } from '@okikio/opfs/path';
export const smoke = () => [createFileSystem(createMemoryAdapter()), normalizePath('a/../b')];
`);
  if (hasDeno) {
    await command("deno", [
      "bundle",
      "--platform=browser",
      "--node-modules-dir=manual",
      "--output",
      "browser-bundle.js",
      "browser.mjs",
    ], { cwd: consumer });
  }

  await command(
    "npm",
    ["install", "--ignore-scripts", "--no-audit", "--no-fund", "drizzle-orm@0.45.2"],
    { cwd: consumer },
  );
  await writeFile(join(consumer, "drizzle.mjs"), `await import('@okikio/opfs/adapter/drizzle');\n`);
  await command("node", ["drizzle.mjs"], { cwd: consumer });
  if (hasDeno) await command("deno", ["run", "--node-modules-dir=manual", "drizzle.mjs"], { cwd: consumer });
  if (hasBun) await command("bun", ["drizzle.mjs"], { cwd: consumer });
} finally {
  await rm(workspace, { recursive: true, force: true });
}
