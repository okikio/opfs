/** Task-owned offline runner. Never imports project production code on the host.
 * Each invocation owns one named container and retires that exact container,
 * even if a command fails. Source snapshots exclude ignored work and dependencies.
 */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defaults, preflight, retain, retire } from "./snapshot.ts";
import type { Policy } from "./snapshot.ts";

const root = resolve(fileURLToPath(new URL("../../", import.meta.url)));
const store = resolve(root, ".tmp/implementation/source-snapshots");
const snapshotOnly = process.argv[2] === "--snapshot-only";
const directory = resolve(
  root,
  ".tmp/implementation/language-validation",
  randomUUID(),
);
await mkdir(directory, { recursive: true });
const archive = resolve(directory, "source.tar");
const log = await open(resolve(directory, "commands.log"), "wx");
const name = `opfs-language-${randomUUID()}`;
const image = "sha256:01f5eb8edbe75e962e78730d6258d2c01c85b1c619d7e47717eeea470148b7f5";
const runtime = process.argv[2] === "--runtime";
const memory = runtime ? "1g" : "2g";
const acquisition = process.env.OPFS_ACQUIRE;
if (
  acquisition !== undefined && acquisition !== "cryptomator" &&
  acquisition !== "package" && acquisition !== "netlify" &&
  acquisition !== "bam" && acquisition !== "vercel"
) {
  throw new Error("Unknown task-owned dependency acquisition scope");
}
const network = acquisition === undefined ? "none" : "bridge";

/** Bound host controller output and wall time separately from container limits.
 * Killing a Docker CLI does not stop its workload; the outer finally owns stop.
 */
async function command(
  argv: string[],
  seconds = 60,
  cap = 8 * 1024 * 1024,
): Promise<string> {
  await log.write(JSON.stringify({ argv, seconds, cap }) + "\n");
  const [program, ...args] = argv;
  if (program === undefined) throw new TypeError("A validation command needs a program name.");
  const child = spawn(program, args, {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  let count = 0;
  const out: Buffer[] = [];
  let fault: Error | undefined;
  const kill = (reason: Error): void => {
    fault ??= reason;
    if (child.pid) {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch { /* Already retired. */ }
    }
  };
  const timeout = setTimeout(
    () => kill(new Error("Command deadline exceeded")),
    seconds * 1000,
  );
  const chunks = async (
    stream: NodeJS.ReadableStream,
    stdout: boolean,
  ): Promise<void> => {
    for await (const chunk of stream) {
      const bytes = Buffer.from(chunk);
      count += bytes.length;
      if (count > cap) {
        kill(new Error("Command output cap exceeded"));
        continue;
      }
      await log.write(bytes);
      if (stdout) out.push(bytes);
    }
  };
  const closed = new Promise<void>((yes, no) => {
    child.once("error", no);
    child.once(
      "close",
      (code) => code === 0 && !fault ? yes() : no(fault ?? new Error(`Command exited ${code}`)),
    );
  });
  try {
    await Promise.all([
      closed,
      chunks(child.stdout!, true),
      chunks(child.stderr!, false),
    ]);
  } finally {
    clearTimeout(timeout);
  }
  return Buffer.concat(out).toString("utf8");
}
const receipt: Record<string, unknown> = {
  image,
  name,
  directory,
  memoryBytes: (runtime ? 1 : 2) * 1024 ** 3,
  network,
};
if (acquisition !== undefined) receipt.acquisition = acquisition;
/** Explicit byte overrides are recorded; exhaustion never triggers deletion of old states. */
function bytes(name: string, fallback: number): number {
  const value = process.env[name];
  if (value === undefined) return fallback;
  if (!/^[0-9]+$/u.test(value) || !Number.isSafeInteger(Number(value))) {
    throw new Error(`${name} must be safe integer bytes`);
  }
  return Number(value);
}
let created = false;
let failed = false;
try {
  const selected = process.argv.slice(runtime ? 3 : 2);
  if (!snapshotOnly && !selected.length) {
    throw new Error("Pass a literal container command and arguments");
  }
  const policy: Policy = {
    reserveBytes: bytes("OPFS_SNAPSHOT_RESERVE_BYTES", defaults.reserveBytes),
    maxBytes: bytes("OPFS_SNAPSHOT_MAX_BYTES", defaults.maxBytes),
  };
  receipt.mode = snapshotOnly ? "source-retention-only" : "container-validation";
  const evidenceReserveBytes = snapshotOnly ? 0 : 1024 ** 3;
  receipt.snapshotPolicy = { ...policy, evidenceReserveBytes };
  const names = (await command([
    "git",
    "-c",
    "core.fsmonitor=false",
    "ls-files",
    "-z",
    "--cached",
    "--others",
    "--exclude-standard",
  ]))
    .split("\0").filter(Boolean);
  const admitted: string[] = [];
  let sourceBytes = 0;
  const requested: unknown = process.env.OPFS_VALIDATION_PREFIXES
    ? JSON.parse(process.env.OPFS_VALIDATION_PREFIXES)
    : undefined;
  if (
    requested !== undefined &&
    (!Array.isArray(requested) || !requested.length ||
      requested.some((path) =>
        typeof path !== "string" || !path || path.startsWith("/") ||
        path.split("/").includes("..") || /[\n\r]/u.test(path)
      ))
  ) {
    throw new Error("Focused source prefixes must be explicit relative paths");
  }
  const prefixes = requested as string[] | undefined;
  if (prefixes) receipt.sourcePrefixes = prefixes;
  for (const path of new Set(names)) {
    if (
      path.startsWith(".agents/") || path.startsWith(".tmp/") ||
      path.startsWith("node_modules/") ||
      path.startsWith("/") || path.split("/").includes("..") ||
      /[\n\r]/u.test(path)
    ) continue;
    if (
      prefixes &&
      !prefixes.some((prefix) => path === prefix || path.startsWith(prefix + "/"))
    ) continue;
    try {
      const input = await lstat(resolve(root, path));
      if (input.isFile()) {
        admitted.push(path);
        sourceBytes += input.size;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  await writeFile(
    resolve(directory, "files.txt"),
    admitted.sort().join("\n") + "\n",
  );
  const estimatedTarBytes = sourceBytes + admitted.length * 4096 + 10240;
  await preflight(store, estimatedTarBytes + evidenceReserveBytes, policy);
  await command([
    "tar",
    "--no-xattrs",
    "--disable-copyfile",
    "-cf",
    archive,
    "-T",
    resolve(directory, "files.txt"),
  ]);
  const kept = await retain(archive, store, policy);
  receipt.snapshotSha256 = kept.sha256;
  receipt.snapshotManifest = kept.manifest;
  receipt.snapshotBytes = kept.bytes;
  // Persist run-to-source identity before any raw tar can be retired, even on interruption.
  const referencePath = resolve(directory, "source-snapshot.json");
  const reference = await open(referencePath, "wx", 0o600);
  try {
    await reference.writeFile(JSON.stringify(kept, null, 2) + "\n");
    await reference.sync();
  } finally {
    await reference.close();
  }
  const runDirectory = await open(directory, "r");
  try {
    await runDirectory.sync();
  } finally {
    await runDirectory.close();
  }
  receipt.snapshotReference = referencePath;
  if (snapshotOnly) {
    receipt.snapshotRetained = true;
  } else {
    await command([
      "docker",
      "create",
      "--name",
      name,
      "--label",
      "opfs.task=language-migration",
      "--network",
      network,
      "--memory",
      memory,
      "--memory-swap",
      memory,
      "--cpus",
      "1",
      "--pids-limit",
      "256",
      "--entrypoint",
      "sleep",
      image,
      "1200",
    ]);
    created = true;
    await command(["docker", "start", name]);
    await command(["docker", "exec", name, "mkdir", "-p", "/candidate"]);
    await command(["docker", "cp", archive, `${name}:/tmp/source.tar`]);
    await command([
      "docker",
      "exec",
      name,
      "tar",
      "-xf",
      "/tmp/source.tar",
      "-C",
      "/candidate",
    ]);
    await command([
      "docker",
      "exec",
      name,
      "ln",
      "-s",
      "/work/node_modules",
      "/candidate/node_modules",
    ]);
    const nativeInput = process.env.OPFS_NATIVE_INPUT;
    if (nativeInput) {
      const inputPath = resolve(nativeInput);
      if (
        !inputPath.startsWith(root + "/.tmp/implementation/") ||
        !(await lstat(inputPath)).isDirectory()
      ) throw new Error("Native input must be an owned evidence directory");
      await command(["docker", "cp", inputPath, `${name}:/native-input`], 180);
      receipt.nativeInput = inputPath;
    }
    receipt.command = selected;
    await command(
      ["docker", "exec", "-w", "/candidate", name, ...selected],
      900,
      16 * 1024 * 1024,
    );
    receipt.passed = true;
  }
} catch (error) {
  failed = true;
  receipt.passed = false;
  receipt.error = String(error);
} finally {
  if (created) {
    try {
      const artifacts = (await command([
        "docker",
        "exec",
        name,
        "sh",
        "-c",
        "if test -d /tmp/opfs-evidence; then printf present; fi",
      ])).trim();
      if (artifacts === "present") {
        await command([
          "docker",
          "cp",
          `${name}:/tmp/opfs-evidence`,
          resolve(directory, "evidence"),
        ]);
        receipt.evidenceDirectory = resolve(directory, "evidence");
      }
    } catch (error) {
      receipt.evidenceError = String(error);
    }
    try {
      const [state] = JSON.parse(
        await command(["docker", "inspect", name]),
      ) as { State: { OOMKilled: boolean } }[];
      if (state === undefined) throw new Error("docker inspect returned no container state.");
      receipt.oomKilled = state.State.OOMKilled;
    } catch (error) {
      receipt.inspectError = String(error);
      failed = true;
    }
    try {
      await command(["docker", "rm", "-f", name]);
      receipt.removed = true;
    } catch (error) {
      receipt.cleanupError = String(error);
      failed = true;
    }
  }
  if (
    typeof receipt.snapshotManifest === "string" &&
    typeof receipt.snapshotReference === "string"
  ) {
    try {
      await retire(archive, receipt.snapshotManifest);
      receipt.snapshotRawRetired = true;
    } catch (error) {
      receipt.snapshotRetentionError = String(error);
      failed = true;
    }
  }
  await log.close();
  await writeFile(
    resolve(directory, "receipt.json"),
    JSON.stringify(receipt, null, 2) + "\n",
  );
  console.log(JSON.stringify(receipt));
}
if (failed) process.exitCode = 1;
