/** Runs each Linux test lane with a named container and bounded CLI/cleanup lifetimes. */
import { randomUUID } from "node:crypto";
import process from "node:process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { open, own } from "./container.ts";
import { capture, diagnostic, observation, retain } from "./command.ts";
import type { DiagnosticType } from "./command.ts";

/** Each lane retains transport, authority and command observations independently. */
type LaneType = {
  image: string;
  name: string;
  command: string[];
  runtimeUID: number;
  status: string;
  imageIdentity?: unknown;
  failures: DiagnosticType | [];
  archiveOwner?: string;
  transportedArchiveSha256?: string;
  transportedBootstrap?: string;
  denoCache?: { rootBootstrap: string; ordinaryInput: string; nodeShim: string; outputOwnership: string };
  modeAdmission?: string;
};

const root = process.cwd();
// The task owns these signal listeners and every CLI it starts, never unrelated Docker resources.
const cancellation = new AbortController();
const stop = () => cancellation.abort(new Error("Linux test runner interrupted."));
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
const failures: unknown[] = [];
let source: Awaited<ReturnType<typeof open>> | undefined;
let report: string | undefined;
let reportOwner: Awaited<ReturnType<typeof own>> | undefined;
let call = 0;
const receipt: {
  status: string;
  admission?: unknown;
  admissionAfter?: unknown;
  failures?: DiagnosticType;
  lanes: LaneType[];
  calls: (ReturnType<typeof observation> & { retentionFailures: DiagnosticType; report?: string })[];
} = { status: "running", lanes: [], calls: [] };
try {
  await mkdir(".tmp/reports/linux", { recursive: true });
  report = await mkdtemp(".tmp/reports/linux/run-");
  // Acquire report authority before starting any CLI. Acquisition failure has no
  // durable command-evidence claim and never starts a diagnostic child.
  reportOwner = await own(report);
  report = reportOwner.directory;
  const config: { tasks: Record<string, string> } = JSON.parse(await readFile("deno.json", "utf8"));
  const cache = JSON.parse(await invoke("deno", ["info", "--json"], 30_000)).denoDir;
  const setupStarted = Date.now();
  source = await open(root, { cache, run: invoke, signal: cancellation.signal });
  await reportOwner.verify();
  await writeFile(`${report}/source-admission.json`, JSON.stringify(source.receipt, null, 2), { flag: "wx" });
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
  const task = (name: string): string => {
    const value = config.tasks[name];
    if (typeof value !== "string" || !value.trim()) throw new Error(`Required repository task is absent: ${name}`);
    return value;
  };
  const nodeArgs = task("test:node").trim().split(/\s+/u).slice(1);
  const denoTasks = ["test:portable", "test:upstream", "test:deno"];
  const denoTests = [
    ...new Set(
      denoTasks.flatMap((name) => task(name).trim().split(/\s+/u).filter((value) => value.startsWith("tests/"))),
    ),
  ];
  const denoPermissions = [
    ...new Set(
      denoTasks.flatMap((name) => task(name).trim().split(/\s+/u).filter((value) => value.startsWith("--allow-"))),
    ),
  ];
  const kvTests = task("test:deno-kv").trim().split(/\s+/u)
    .filter((value) => value.startsWith("tests/"));
  const bunArgs = task("test:bun").trim().split(/\s+/u).slice(1);
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
    "--cap-add",
    "CHOWN",
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
  // These offline lanes run Deno itself. Its optional native `node` launcher
  // would point outside the sealed cache before worker admission begins. Real
  // Node compatibility remains the responsibility of the separate Node lanes.
  const deno = [
    ...native,
    "--env",
    `DENO_DIR=${directory}/deno-cache`,
    "--env",
    "DENO_DISABLE_NODE_SHIM=1",
  ];
  const cases: [string, string[], string[], string[]][] = [
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
    const errors: unknown[] = [];
    const lane: LaneType = { image, name, command, runtimeUID: 1000, status: "running", failures: [] };
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
      // Docker cp can retain the outer UID on this private copied archive.
      // Root with only CHOWN first acquires that owned byte transport; no
      // maintained or borrowed host input exists inside this authority.
      await invoke("docker", ["exec", "--user", "0:0", name, "chown", "0:0", "/tmp/opfs-inputs.tar"], 30_000);
      await invoke("docker", ["exec", "--user", "0:0", name, "chmod", "600", "/tmp/opfs-inputs.tar"], 30_000);
      lane.archiveOwner = (await invoke(
        "docker",
        ["exec", "--user", "0:0", name, "stat", "--format", "%u:%g:%a", "/tmp/opfs-inputs.tar"],
        15_000,
      )).trim();
      if (lane.archiveOwner !== "0:0:600") throw new Error("Private Linux archive owner or mode differs.");
      lane.transportedArchiveSha256 =
        (await invoke("docker", ["exec", "--user", "0:0", name, "sha256sum", "/tmp/opfs-inputs.tar"], 180_000)).trim()
          .split(/\s+/u)[0] ?? "";
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
      const worker = `${directory}/source/.mise/tasks/container-worker.ts`;
      const supervisor = `${directory}/source/.mise/tasks/attest.sh`;
      const handshake = `${directory}/source/.mise/tasks/attest.ts`;
      const transported =
        (await invoke("docker", ["exec", "--user", "0:0", name, "sha256sum", worker, supervisor, handshake], 30_000))
          .trimEnd();
      const expected =
        `${source.receipt.workerSha256}  ${worker}\n${source.receipt.supervisorSha256}  ${supervisor}\n${source.receipt.handshakeSha256}  ${handshake}`;
      if (transported !== expected) throw new Error("Linux bootstrap bytes differ from independent host admission.");
      lane.transportedBootstrap = transported;
      const rootGate = `/tmp/library-attest-${randomUUID()}`;
      // Admission uses only local modules and native built-ins. Deno may write
      // analysis/SQLite metadata before those modules execute, so root startup
      // gets its own disposable output cache instead of touching input bytes.
      // Ordinary startup still uses the complete, now readonly admitted cache.
      const rootCache = bootstrap[0] === "deno" ? `/tmp/opfs-bootstrap-${randomUUID()}` : undefined;
      if (rootCache) {
        lane.denoCache = {
          rootBootstrap: rootCache,
          ordinaryInput: `${directory}/deno-cache`,
          nodeShim: "disabled",
          outputOwnership: "named-container",
        };
      }
      lane.modeAdmission = await invoke("docker", [
        "exec",
        "--user",
        "0:0",
        ...(rootCache ? ["--env", `DENO_DIR=${rootCache}`] : []),
        "--workdir",
        `${directory}/source`,
        name,
        "/bin/sh",
        supervisor,
        "root",
        rootGate,
        randomUUID(),
        ...bootstrap,
        ...(bootstrap[0] === "deno" ? [`--allow-write=${directory},${rootGate}`] : []),
        worker,
        directory,
        "--admit",
      ], 180_000);
      // Attestation reads the actual runtime child externally; Deno never receives protected proc or allow-all rights.
      const gate = `/tmp/library-attest-${randomUUID()}`;
      const output = await invoke("docker", [
        "exec",
        "--user",
        "1000:1000",
        "--workdir",
        `${directory}/source`,
        name,
        "/bin/sh",
        supervisor,
        "ordinary",
        gate,
        randomUUID(),
        ...bootstrap,
        ...(bootstrap[0] === "deno" ? [`--allow-write=${gate}`] : []),
        worker,
        directory,
        ...command,
      ], 180_000);
      await reportOwner.verify();
      await writeFile(`${report}/${name}.log`, output, { flag: "wx" });
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
        await invoke("docker", ["rm", "--force", "--volumes", name], 30_000, true, name);
      } catch (cause) {
        errors.push(new Error(`Could not confirm cleanup of ${name}.`, { cause }));
      }
    }
    if (errors.length) {
      lane.status = "fail";
      lane.failures = diagnostic(errors);
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
      receipt.admissionAfter = {
        status: "fail",
        diagnostic: diagnostic(error),
      };
      failures.push(error);
    }
    try {
      await source.close();
    } catch (error) {
      failures.push(error);
    }
  }
  receipt.status = failures.length ? "fail" : "pass";
  receipt.failures = diagnostic(failures);
  if (reportOwner) {
    try {
      await reportOwner.verify();
      await writeFile(`${report}/metadata.json`, JSON.stringify(receipt, null, 2), { flag: "wx" });
      await reportOwner.verify();
    } catch (error) {
      failures.push(error);
    }
  }
  process.removeListener("SIGINT", stop);
  process.removeListener("SIGTERM", stop);
}
if (failures.length) throw new AggregateError(failures, "Linux test lanes failed.", { cause: failures[0] });

/**
 * Retains each native observation before deciding its result. Text callers decode
 * once; binary output never enters a stack or JSON body. Killing this CLI does
 * not remove a daemon-side container; each lane owns independent named cleanup.
 */
async function invoke(
  command: string,
  args: string[],
  timeout: number,
  cleanup = false,
  absentContainer?: string,
): Promise<string> {
  const output = await capture(command, args, {
    timeoutMs: timeout,
    ...(cleanup ? {} : { signal: cancellation.signal }),
  });
  let record;
  try {
    if (!reportOwner) throw new Error("Command evidence requires its acquired report owner.");
    record = await retain(output, reportOwner, `call-${String(++call).padStart(4, "0")}`);
  } catch (reason) {
    record = { ...observation(output), retentionFailures: [{ stage: "retain", reason }] };
  }
  receipt.calls.push({ ...record, retentionFailures: diagnostic(record.retentionFailures) });
  const stdout = output.stdout.bytes.toString("utf8");
  const stderr = output.stderr.bytes.toString("utf8");
  // An exact daemon absence is a cleanup observation, never a blanket successful
  // CLI exit. Capture and evidence faults still refuse cleanup confirmation.
  const absent = absentContainer && output.exitObserved && output.code === 1 && output.signal === null &&
    output.closeObserved && output.stdout.complete && output.stderr.complete && output.failures.length === 0 &&
    stderr.includes(`No such container: ${absentContainer}`);
  const errors = [
    ...output.failures.map((failure) => failure.reason),
    ...record.retentionFailures.map((failure) => failure.reason),
  ];
  if (!output.success && !absent) {
    errors.unshift(new Error("Native command did not complete successfully.", { cause: observation(output) }));
  }
  if (errors.length) {
    throw new AggregateError(errors, `${command} failed; inspect retained command evidence.`, {
      cause: {
        observation: { ...record, retentionFailures: diagnostic(record.retentionFailures) },
        primary: errors[0],
      },
    });
  }
  if (stderr && !absent) console.error(stderr.trimEnd());
  return stdout;
}
