import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { undent } from "@okikio/undent";

const argument = process.argv[2];
if (argument === undefined || argument.length === 0) {
  throw new Error("Pass the npm tarball path.");
}
const tarball = resolve(argument);

/** Runs one child command and rejects when it exits unsuccessfully. */
function command(file, args, options = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(file, args, { stdio: "inherit", ...options });
    child.on("error", reject);
    child.on(
      "exit",
      (code) => code === 0 ? resolvePromise() : reject(new Error(`${file} exited with ${code}.`)),
    );
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

/** Releases every acquired resource in reverse order without losing any rejection reason. */
async function finish(releases, failures = []) {
  for (const release of releases.toReversed()) {
    try {
      await release();
    } catch (reason) {
      failures.push(reason);
    }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) {
    throw new AggregateError(
      failures,
      "Package fixture and owned cleanup failed.",
      { cause: failures[0] },
    );
  }
}

const workspace = await mkdtemp(join(tmpdir(), "okikio-opfs-package-"));
const failures = [];
try {
  const extracted = join(workspace, "extracted");
  await command("mkdir", ["-p", extracted]);
  await command("tar", ["-xzf", tarball, "-C", extracted]);
  const packageRoot = join(extracted, "package");
  const manifest = JSON.parse(
    await readFile(join(packageRoot, "package.json"), "utf8"),
  );

  const readme = await readFile(join(packageRoot, "README.md"), "utf8");
  await readFile(join(packageRoot, "LICENSE"), "utf8");
  await readFile(join(packageRoot, "CHANGELOG.md"), "utf8");
  // A reader must be able to follow the local documentation links in the installed package.
  for (
    const match of readme.matchAll(/\]\((?:\.\/)?(docs\/[^)#]+)(?:#[^)]*)?\)/gu)
  ) {
    await readFile(join(packageRoot, match[1]), "utf8");
  }

  if (manifest.name !== "@okikio/opfs") {
    throw new Error(`Unexpected npm package name: ${manifest.name}`);
  }
  if (manifest.dependencies?.["drizzle-orm"]) {
    throw new Error("drizzle-orm must not be a normal npm dependency.");
  }
  if (!manifest.peerDependencies?.["drizzle-orm"]) {
    throw new Error("drizzle-orm optional peer is missing.");
  }
  if (manifest.peerDependenciesMeta?.["drizzle-orm"]?.optional !== true) {
    throw new Error("drizzle-orm must be marked as an optional peer.");
  }
  if (!manifest.dependencies?.zod) {
    throw new Error("zod runtime dependency is missing.");
  }

  for (
    const field of ["dependencies", "peerDependencies", "optionalDependencies"]
  ) {
    for (const name of Object.keys(manifest[field] ?? {})) {
      if (name.startsWith("@jsr/")) {
        throw new Error(
          `npm tarball leaked JSR compatibility dependency '${name}' through ${field}.`,
        );
      }
    }
  }

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
  if (rawTs.length > 0) {
    throw new Error(`npm tarball contains raw TypeScript: ${rawTs.join(", ")}`);
  }

  const consumer = join(workspace, "consumer");
  await command("mkdir", ["-p", consumer]);
  await writeFile(
    join(consumer, "package.json"),
    `${JSON.stringify({ private: true, type: "module" }, null, 2)}\n`,
  );
  await command("npm", [
    "install",
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    tarball,
  ], { cwd: consumer });

  await writeFile(
    join(consumer, "smoke.mjs"),
    undent`
    import { createFileSystem } from '@okikio/opfs';
    import { createMemoryAdapter } from '@okikio/opfs/adapter/memory';
    import { normalizePath } from '@okikio/opfs/path';
    ${finish.toString()}
    const failures = [], releases = [];
    let writer;
    try {
    const fileSystem = createFileSystem(createMemoryAdapter(), { coordination: 'local' });
    releases.push(() => fileSystem.close());
    const bytes = Uint8Array.from({ length: 65537 }, (_, index) => index % 251);
    await fileSystem.writeFile('/state/file.bin', bytes, { parents: true });
    const assertBytes = (actual, expected) => {
      if (actual.length !== expected.length || actual.some((value, index) => value !== expected[index])) {
        throw new Error('Packed consumer bytes differ');
      }
    };
    assertBytes(await fileSystem.readFile('/state/file.bin'), bytes);
    assertBytes(await fileSystem.readFile('/state/file.bin', { at: 65530, length: 7 }), bytes.slice(65530));
    await fileSystem.copy('/state/file.bin', '/copy.bin');
    await fileSystem.move('/copy.bin', '/moved.bin');
    assertBytes(await fileSystem.readFile('/moved.bin'), bytes);
    if (await fileSystem.exists('/copy.bin')) throw new Error('Move retained the source');
    const handle = await fileSystem.getFileHandle('/moved.bin');
    writer = await handle.createWritable({ keepExistingData: true });
    releases.push(async () => { if (writer !== undefined) await writer.abort(); });
    await writer.write({ type: 'write', position: 0, data: new Uint8Array([255]) });
    await writer.abort();
    writer = undefined;
    assertBytes(await fileSystem.readFile('/moved.bin'), bytes);
    const signal = AbortSignal.abort();
    let aborted = false;
    try { await fileSystem.writeFile('/aborted.bin', bytes, { signal }); } catch (error) {
      aborted = error.code === 'aborted';
    }
    if (!aborted || await fileSystem.exists('/aborted.bin')) throw new Error('Aborted write published data');
    if (normalizePath('a/../b') !== '/b') throw new Error('npm path smoke failed');
    await import('@okikio/opfs/adapter/node');
    await import('@okikio/opfs/adapter/deno');
    await import('@okikio/opfs/adapter/bun');
    } catch (reason) { failures.push(reason); }
    finally { await finish(releases, failures); }
    console.log('Packed memory workflow passed');
`,
  );
  await command("node", ["smoke.mjs"], { cwd: consumer });

  const hasDeno = await hasCommand("deno");
  const hasBun = await hasCommand("bun");
  if (!hasDeno || !hasBun) {
    throw new Error(
      "Package verification requires actual Node, Deno, and Bun runtimes.",
    );
  }
  if (hasDeno) {
    await command("deno", [
      "run",
      "--no-config",
      "--node-modules-dir=manual",
      "smoke.mjs",
    ], {
      cwd: consumer,
    });
  }
  if (hasBun) await command("bun", ["smoke.mjs"], { cwd: consumer });

  await writeFile(
    join(consumer, "native.mjs"),
    undent`
    import { mkdtemp, rm } from 'node:fs/promises';
    import { fileURLToPath } from 'node:url';
    import { createFileSystem } from '@okikio/opfs';
    ${finish.toString()}
    const failures = [], releases = [];
    const runtime = typeof Bun !== 'undefined' ? 'bun' : typeof Deno !== 'undefined' ? 'deno' : 'node';
    try {
    const module = await import('@okikio/opfs/adapter/' + runtime);
    const root = await mkdtemp(fileURLToPath(new URL('./opfs-packed-native-', import.meta.url)));
    releases.push(() => rm(root, { recursive: true, force: true }));
    const adapter = module[runtime === 'bun' ? 'createBunAdapter' : runtime === 'deno' ? 'createDenoAdapter' : 'createNodeAdapter']({ root });
    const fs = createFileSystem(adapter, { coordination: 'local' });
    releases.push(() => fs.close());
      await fs.writeFile('/data.txt', '0123456789');
      await fs.writeFile('/data.txt', 'AB', { mode: 'update', at: 3 });
      if (await fs.readText('/data.txt') !== '012AB56789') throw new Error(runtime + ' update mismatch');
      await fs.copy('/data.txt', '/copy.txt');
      await fs.move('/copy.txt', '/moved.txt');
      if (await fs.readText('/moved.txt') !== '012AB56789') throw new Error(runtime + ' move mismatch');
      if (await fs.exists('/copy.txt')) throw new Error(runtime + ' move retained source');
    } catch (reason) { failures.push(reason); }
    finally { await finish(releases, failures); }
    console.log('Packed ' + runtime + ' native workflow passed');
  `,
  );
  await command("node", ["native.mjs"], { cwd: consumer });
  await command("deno", [
    "run",
    "--no-config",
    "--allow-read",
    "--allow-write",
    "--allow-env=TMPDIR,TMP,TEMP",
    "--node-modules-dir=manual",
    "native.mjs",
  ], {
    cwd: consumer,
  });
  await command("bun", ["native.mjs"], { cwd: consumer });

  await writeFile(
    join(consumer, "consumer.ts"),
    undent`
    import { createFileSystem, type FileSystemType } from '@okikio/opfs';
    import { createMemoryAdapter } from '@okikio/opfs/adapter/memory';
    const fileSystem: FileSystemType = createFileSystem(createMemoryAdapter());
    await fileSystem.writeFile('/types.txt', 'ok', { parents: true });
`,
  );
  if (hasDeno) {
    await command(
      "deno",
      ["check", "--no-config", "--node-modules-dir=manual", "consumer.ts"],
      { cwd: consumer },
    );
  }

  await writeFile(
    join(consumer, "browser.mjs"),
    undent`
    import { createFileSystem } from '@okikio/opfs';
    import { createMemoryAdapter } from '@okikio/opfs/adapter/memory';
    import { normalizePath } from '@okikio/opfs/path';
    export const smoke = () => [createFileSystem(createMemoryAdapter()), normalizePath('a/../b')];
`,
  );
  if (hasDeno) {
    await command("deno", [
      "bundle",
      "--no-config",
      "--platform=browser",
      "--node-modules-dir=manual",
      "--output",
      "browser-bundle.js",
      "browser.mjs",
    ], { cwd: consumer });
  }

  await command(
    "npm",
    [
      "install",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "drizzle-orm@0.45.2",
    ],
    { cwd: consumer },
  );
  await writeFile(
    join(consumer, "drizzle.mjs"),
    `await import('@okikio/opfs/adapter/drizzle');\n`,
  );
  await command("node", ["drizzle.mjs"], { cwd: consumer });
  if (hasDeno) {
    await command("deno", [
      "run",
      "--no-config",
      "--node-modules-dir=manual",
      "drizzle.mjs",
    ], {
      cwd: consumer,
    });
  }
  if (hasBun) await command("bun", ["drizzle.mjs"], { cwd: consumer });

  const specs = Object.keys(manifest.exports).map((key) =>
    key === "." ? "@okikio/opfs" : `@okikio/opfs/${key.slice(2)}`
  );
  await writeFile(
    join(consumer, "exports.mjs"),
    undent`
    import { realpath } from 'node:fs/promises';
    import { dirname, isAbsolute, join, relative, sep } from 'node:path';
    import { fileURLToPath } from 'node:url';
    const consumer = await realpath(dirname(fileURLToPath(import.meta.url)));
    const root = await realpath(join(consumer, 'node_modules/@okikio/opfs'));
    if (relative(consumer, root) !== join('node_modules', '@okikio', 'opfs')) {
      throw new Error('Package root is outside the fresh installed consumer: ' + root);
    }
    for (const spec of ${JSON.stringify(specs)}) {
      const path = await realpath(fileURLToPath(import.meta.resolve(spec)));
      const inside = relative(root, path);
      if (inside === '..' || inside.startsWith('..' + sep) || isAbsolute(inside)) {
        throw new Error(spec + ' resolved outside the installed package: ' + path);
      }
      await import(spec);
    }
    console.log('Imported ${specs.length} physically installed packed public entrypoints');
`,
  );
  await command("node", ["exports.mjs"], { cwd: consumer });
  await command("deno", [
    "run",
    "--no-config",
    "--allow-read",
    "--node-modules-dir=manual",
    "exports.mjs",
  ], {
    cwd: consumer,
  });
  await command("bun", ["exports.mjs"], { cwd: consumer });
} catch (reason) {
  failures.push(reason);
} finally {
  await finish(
    [() => rm(workspace, { recursive: true, force: true })],
    failures,
  );
}
