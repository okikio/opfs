/** Runs each Linux test lane with a named container and bounded CLI/cleanup lifetimes. */
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

const root = process.cwd();
// The task owns these signal listeners and every CLI it starts, never unrelated Docker resources.
const cancellation = new AbortController();
const stop = () => cancellation.abort(new Error("Linux test runner interrupted."));
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
const config = JSON.parse(await readFile("deno.json", "utf8"));
const cache = JSON.parse(await invoke("deno", ["info", "--json"], 30_000)).denoDir;
// These repository-owned commands contain plain filenames, without shell quoting or expansion.
const nodeArgs = config.tasks["test:node"].trim().split(/\s+/u).slice(1);
const denoTasks = ["test:portable", "test:upstream", "test:deno"];
const denoTests = [
  ...new Set(
    denoTasks.flatMap((name) => config.tasks[name].trim().split(/\s+/u).filter((value) => value.startsWith("tests/"))),
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
  "--volume",
  `${root}:/workspace:ro`,
  "--workdir",
  "/workspace",
];
const deno = [...native, "--volume", `${cache}:/deno-cache:ro`, "--env", "DENO_DIR=/deno-cache"];
const cases = [
  ["node:22.18.0-bookworm-slim", native, ["node", ...nodeArgs]],
  ["node:24.21.0-slim", native, ["node", ...nodeArgs]],
  ["denoland/deno:2.9.7", deno, [
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
  ["oven/bun:1.3.14", native, ["bun", ...bunArgs]],
];
const failures = [];
for (const [image, options, command] of cases) {
  if (cancellation.signal.aborted) {
    failures.push(cancellation.signal.reason);
    break;
  }
  const name = `opfs-linux-${randomUUID()}`;
  const errors = [];
  let created = false;
  console.log(`Testing ${image} in owned container ${name}.`);
  try {
    await invoke("docker", ["create", "--name", name, ...options, image, ...command], 30_000);
    created = true;
    await invoke("docker", ["start", name], 30_000);
    const exit = (await invoke("docker", ["wait", name], 180_000)).trim();
    if (exit !== "0") throw new Error(`Test process exited ${exit}.`);
    console.log(await invoke("docker", ["image", "inspect", "--format", "{{json .RepoDigests}}", image], 15_000));
  } catch (cause) {
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
  if (errors.length) failures.push(new AggregateError(errors, `Linux lane ${image} failed.`, { cause: errors[0] }));
}
process.removeListener("SIGINT", stop);
process.removeListener("SIGTERM", stop);
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
