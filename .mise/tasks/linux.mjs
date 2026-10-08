/** Runs each Linux test lane with a named container and bounded CLI/cleanup lifetimes. */
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { open } from "./container.mjs";

const root = process.cwd();
// The task owns these signal listeners and every CLI it starts, never unrelated Docker resources.
const cancellation = new AbortController();
const stop = () => cancellation.abort(new Error("Linux test runner interrupted."));
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
const failures = [];
let source;
let report;
const receipt = { status: "running", admission: undefined, admissionAfter: undefined, lanes: [] };
try {
  const config = JSON.parse(await readFile("deno.json", "utf8"));
  const cache = JSON.parse(await invoke("deno", ["info", "--json"], 30_000)).denoDir;
  await mkdir(".tmp/reports/linux", { recursive: true });
  report = await mkdtemp(".tmp/reports/linux/run-");
  const setupStarted = Date.now();
  source = await open(root, { cache, run: invoke, signal: cancellation.signal });
  await writeFile(`${report}/source-admission.json`, JSON.stringify(source.receipt, null, 2));
  receipt.admission = {
    report: `${report}/source-admission.json`,
    archiveSha256: source.archiveSha256,
    setupMilliseconds: Date.now() - setupStarted,
  };
  console.log(
    JSON.stringify({
      phase: "source-admission",
      report,
      archiveSha256: source.archiveSha256,
      paths: source.receipt.paths,
      fileBytes: source.receipt.fileBytes,
    }),
  );
  // These repository-owned commands contain plain filenames, without shell quoting or expansion.
  const nodeArgs = config.tasks["test:node"].trim().split(/\s+/u).slice(1);
  const denoTasks = ["test:portable", "test:upstream", "test:deno"];
  const denoTests = [
    ...new Set(
      denoTasks.flatMap((name) =>
        config.tasks[name].trim().split(/\s+/u).filter((value) => value.startsWith("tests/"))
      ),
    ),
  ];
  const denoPermissions = [
    ...new Set(
      denoTasks.flatMap((name) =>
        config.tasks[name].trim().split(/\s+/u).filter((value) => value.startsWith("--allow-"))
      ),
    ),
  ];
  const kvTests = config.tasks["test:deno-kv"].trim().split(/\s+/u)
    .filter((value) => value.startsWith("tests/"));
  const bunArgs = config.tasks["test:bun"].trim().split(/\s+/u).slice(1);
  const native = [
    "--network",
    "none",
    "--memory",
    "1g",
    "--memory-swap",
    "1g",
    "--cpus",
    "1",
    "--pids-limit",
    "512",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--user",
    "0:0",
    "--entrypoint",
    "/bin/sh",
    "--workdir",
    "/tmp",
  ];
  const directory = "/tmp/opfs-container";
  const deno = [...native, "--env", `DENO_DIR=${directory}/deno-cache`];
  const cases = [
    ["node:22.18.0-bookworm-slim", native, ["node"], ["node", ...nodeArgs]],
    ["node:24.21.0-slim", native, ["node"], ["node", ...nodeArgs]],
    ["denoland/deno:2.9.7", deno, [
      "deno",
      "run",
      "--node-modules-dir=manual",
      "--cached-only",
      "--allow-read",
      "--allow-run",
      "--allow-env",
    ], [
      "deno",
      "test",
      "--node-modules-dir=manual",
      "--cached-only",
      "--no-check",
      "--sanitize-ops",
      "--sanitize-resources",
      ...denoPermissions,
      ...denoTests,
    ]],
    ["denoland/deno:2.9.7", deno, [
      "deno",
      "run",
      "--node-modules-dir=manual",
      "--cached-only",
      "--allow-read",
      "--allow-run",
      "--allow-env",
    ], [
      "deno",
      "test",
      "--node-modules-dir=manual",
      "--cached-only",
      "--no-check",
      "--unstable-kv",
      "--sanitize-ops",
      "--sanitize-resources",
      "--allow-read",
      "--allow-write",
      ...kvTests,
    ]],
    ["oven/bun:1.3.14", native, ["bun"], ["bun", ...bunArgs]],
  ];
  for (const [image, options, bootstrap, command] of cases) {
    if (cancellation.signal.aborted) {
      failures.push(cancellation.signal.reason);
      break;
    }
    const name = `opfs-linux-${randomUUID()}`;
    const errors = [];
    const lane = { image, name, command, runtimeUID: 1000, status: "running", imageIdentity: undefined, failures: [] };
    receipt.lanes.push(lane);
    let created = false;
    console.log(`Testing ${image} in owned container ${name}.`);
    try {
      await invoke("docker", ["create", "--name", name, ...options, image, "-c", "sleep 3600"], 30_000);
      created = true;
      const imageID = (await invoke("docker", ["inspect", "--format", "{{.Image}}", name], 15_000)).trim();
      lane.imageIdentity = JSON.parse(
        await invoke("docker", ["image", "inspect", "--format", "{{json .}}", imageID], 15_000),
      );
      // Daemon copies bytes through its API; it never mounts the host checkout.
      await invoke("docker", ["cp", source.archive, `${name}:/tmp/opfs-inputs.tar`], 180_000);
      await invoke("docker", ["start", name], 30_000);
      lane.transportedArchiveSha256 =
        (await invoke("docker", ["exec", "--user", "0:0", name, "sha256sum", "/tmp/opfs-inputs.tar"], 180_000)).trim()
          .split(/\s+/u)[0];
      if (lane.transportedArchiveSha256 !== source.archiveSha256) {
        throw new Error("Linux transported source archive differs.");
      }
      await invoke("docker", [
        "exec",
        "--user",
        "0:0",
        name,
        "sh",
        "-c",
        `set -e; mkdir -p ${directory}; tar --no-same-owner -xf /tmp/opfs-inputs.tar -C ${directory}; rm /tmp/opfs-inputs.tar`,
      ], 180_000);
      // Byte/kind/link admission precedes mode establishment in the private
      // Linux copy, including archives created on hosts without POSIX metadata.
      lane.modeAdmission = await invoke("docker", [
        "exec",
        "--user",
        "0:0",
        "--workdir",
        `${directory}/source`,
        name,
        ...bootstrap,
        ...(bootstrap[0] === "deno" ? [`--allow-write=${directory}`] : []),
        `${directory}/source/.mise/tasks/container-worker.mjs`,
        directory,
        "--admit",
      ], 180_000);
      // The extraction authority is root only in its private copy. Source stays
      // root-owned/read-only; every real test runs as ordinary UID/GID 1000.
      const output = await invoke("docker", [
        "exec",
        "--user",
        "1000:1000",
        "--workdir",
        `${directory}/source`,
        name,
        ...bootstrap,
        `${directory}/source/.mise/tasks/container-worker.mjs`,
        directory,
        ...command,
      ], 180_000);
      await writeFile(`${report}/${name}.log`, output);
      console.log(output);
      lane.status = "pass";
    } catch (cause) {
      lane.status = "fail";
      errors.push(new Error(`Linux lane ${image} failed in ${name}.`, { cause }));
    } finally {
      if (created) {
        try {
          console.log(await invoke("docker", ["logs", name], 15_000, true));
        } catch (cause) {
          errors.push(new Error(`Could not read diagnostics for ${name}.`, { cause }));
        }
      }
      // A timed-out create may still create a daemon-side container. Remove only its unique owned name.
      try {
        await invoke("docker", ["rm", "--force", "--volumes", name], 30_000, true);
      } catch (cause) {
        if (!(cause instanceof Error) || !cause.message.includes(`No such container: ${name}`)) {
          errors.push(new Error(`Could not confirm cleanup of ${name}.`, { cause }));
        }
      }
    }
    if (errors.length) {
      lane.status = "fail";
      lane.failures = errors.map((error) => error.stack ?? String(error));
      failures.push(new AggregateError(errors, `Linux lane ${image} failed.`, { cause: errors[0] }));
    }
  }
} catch (error) {
  failures.push(error);
} finally {
  if (source) {
    try {
      receipt.admissionAfter = await source.verify();
    } catch (error) {
      failures.push(error);
    }
    try {
      await source.close();
    } catch (error) {
      failures.push(error);
    }
  }
  receipt.status = failures.length ? "fail" : "pass";
  receipt.failures = failures.map((error) => error instanceof Error ? error.stack ?? error.message : String(error));
  if (report) {
    try {
      await writeFile(`${report}/metadata.json`, JSON.stringify(receipt, null, 2));
    } catch (error) {
      failures.push(error);
    }
  }
  process.removeListener("SIGINT", stop);
  process.removeListener("SIGTERM", stop);
}
if (failures.length) throw new AggregateError(failures, "Linux test lanes failed.", { cause: failures[0] });

/**
 * Uses the process API's timeout and buffer limit instead of an unbounded docker run.
 * Killing this CLI does not remove a container; each caller owns independent cleanup.
 */
function invoke(command, args, timeout, cleanup = false) {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      {
        timeout,
        killSignal: "SIGKILL",
        maxBuffer: 16 * 1024 * 1024,
        ...(cleanup ? {} : { signal: cancellation.signal }),
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(
            new Error(`${command} ${args.join(" ")} failed: ${error.message}\n${stdout}\n${stderr}`, { cause: error }),
          );
        } else {
          if (stderr) console.error(stderr.trimEnd());
          resolve(stdout);
        }
      },
    );
  });
}
