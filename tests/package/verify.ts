/**
 * Verify a real npm tarball through a disposable installed consumer.
 *
 * Archive admission, runtime behavior, declaration environments, browser bundles
 * and fresh-process imports establish separate claims. Each gate must pass;
 * the caller owns publication and this program always removes its workspace.
 *
 * @module
 */
import process from "node:process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { inspectArtifact } from "./artifact.ts";
import { prepareConsumer } from "./prepare.ts";
import { command, hasCommand } from "./process.ts";
import { finish } from "./consumer/finish.mjs";

const argument = process.argv[2];
if (argument === undefined || argument.length === 0) {
  throw new Error("Pass the npm tarball path.");
}
const tarball = resolve(argument);
const workspace = await mkdtemp(join(tmpdir(), "okikio-opfs-package-"));
const failures: unknown[] = [];
try {
  const extracted = join(workspace, "extracted");
  await mkdir(extracted, { recursive: true });
  await command("tar", ["-xzf", tarball, "-C", extracted]);
  const { manifest, expected } = await inspectArtifact(join(extracted, "package"));
  const consumer = join(workspace, "consumer");
  await prepareConsumer(consumer);
  await command("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", tarball], { cwd: consumer });

  if (!await hasCommand("deno") || !await hasCommand("bun")) {
    throw new Error("Package verification requires actual Node, Deno, and Bun runtimes.");
  }
  // Native runners discover every authored .test.mjs file; each case owns its resources.
  // Serial file execution bounds corpus memory and keeps process-level failures visible.
  await command("node", ["--test", "--test-concurrency=1", "runtime"], { cwd: consumer });
  await command("deno", ["test", "--no-check", "--no-config", "--node-modules-dir=manual", "runtime"], {
    cwd: consumer,
  });
  await command("bun", ["test", "./runtime"], { cwd: consumer });

  await command("node", ["native.mjs"], { cwd: consumer });
  await command("deno", [
    "run",
    "--no-config",
    "--allow-read",
    "--allow-write",
    "--allow-env=TMPDIR,TMP,TEMP",
    "--node-modules-dir=manual",
    "native.mjs",
  ], { cwd: consumer });
  await command("bun", ["native.mjs"], { cwd: consumer });

  await command("deno", ["check", "--no-config", "--node-modules-dir=manual", "types/root.ts"], { cwd: consumer });
  // These real compilers and host declarations are consumer tooling, never package dependencies.
  await command("npm", [
    "install",
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    "typescript@7.0.2",
    "typescript59@npm:typescript@5.9.3",
    "@types/node@26.2.0",
  ], { cwd: consumer });
  for (const compiler of ["typescript", "typescript59"]) {
    await command("node", ["typecheck.mjs", "types/node.ts", "node", compiler], { cwd: consumer });
    for (const discovery of ["default", "explicit"]) {
      await command("node", ["typecheck.mjs", "types/portable.ts", discovery, compiler], { cwd: consumer });
      await command("node", ["typecheck.mjs", "types/deno.ts", discovery, compiler], { cwd: consumer });
    }
  }

  await command("deno", [
    "bundle",
    "--no-config",
    "--platform=browser",
    "--node-modules-dir=manual",
    "--output",
    "browser/browser-bundle.js",
    "browser/entry.mjs",
  ], { cwd: consumer });
  await command("deno", [
    "bundle",
    "--no-config",
    "--platform=browser",
    "--node-modules-dir=manual",
    "--output",
    "browser/optional-browser-bundle.js",
    "browser/optional.mjs",
  ], { cwd: consumer });
  const browserBundle = await readFile(join(consumer, "browser/browser-bundle.js"), "utf8");
  for (
    const marker of [
      "jwe-compact-dir-a128gcm",
      "Nats-Expected-Stream",
      "Parquet Compact",
      "x-amz-glacier-version",
      "netlify-blobs-11.1.7-api-v1",
    ]
  ) {
    if (browserBundle.includes(marker)) throw new Error("Memory-only bundle retained optional protocol: " + marker);
  }
  await command("node", ["browser/verify.mjs"], { cwd: consumer });

  await command("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", "drizzle-orm@0.45.2"], {
    cwd: consumer,
  });
  await command("node", ["imports/drizzle.mjs"], { cwd: consumer });
  await command("deno", ["run", "--no-config", "--node-modules-dir=manual", "imports/drizzle.mjs"], { cwd: consumer });
  await command("bun", ["imports/drizzle.mjs"], { cwd: consumer });

  // Fresh processes install ambient guards before any candidate module can enter a cache.
  await command("node", ["imports/optional.mjs"], { cwd: consumer });
  await command("deno", ["run", "--no-config", "--allow-read", "--node-modules-dir=manual", "imports/optional.mjs"], {
    cwd: consumer,
  });
  await command("bun", ["imports/optional.mjs"], { cwd: consumer });

  const specs = Object.keys(manifest.exports ?? {}).map((key) =>
    key === "." ? "@okikio/opfs" : `@okikio/opfs/${key.slice(2)}`
  );
  if (specs.length !== expected.length) {
    throw new Error(`Expected all ${expected.length} recorded public entrypoints, found ${specs.length}.`);
  }
  if (Object.keys(manifest.exports ?? {}).some((key) => key === "./aws" || key.includes("*"))) {
    throw new Error("Internal AWS signing must remain outside the explicit public export map.");
  }
  await writeFile(join(consumer, "data/exports.json"), JSON.stringify(specs));
  await command("node", ["imports/exports.mjs"], { cwd: consumer });
  await command("deno", ["run", "--no-config", "--allow-read", "--node-modules-dir=manual", "imports/exports.mjs"], {
    cwd: consumer,
  });
  await command("bun", ["imports/exports.mjs"], { cwd: consumer });
} catch (reason) {
  failures.push(reason);
} finally {
  await finish([() => rm(workspace, { recursive: true, force: true })], failures);
}
