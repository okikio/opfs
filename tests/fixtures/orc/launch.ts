/** Creates only the named immutable offline stage; never pulls, builds or commits an image. */
import { deepStrictEqual, equal, ok } from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { ARROW } from "../arrow/artifacts.ts";
import { MIB, read, sha } from "../arrow/files.ts";
import { supervise } from "../arrow/runner.ts";

const BASE = "sha256:add5c17c14752c54d2f3d519ec46a3815684d41c33f198bcb09fb998f7dcbf68";
const { values: args } = parseArgs({
  options: {
    stage: { type: "string" },
    "image-id": { type: "string" },
    name: { type: "string" },
    receipts: { type: "string" },
    output: { type: "string" },
  },
});
ok(args.stage === "install" || args.stage === "native");
ok(args["image-id"] !== undefined && /^sha256:[a-f0-9]{64}$/u.test(args["image-id"]));
ok(args.name !== undefined && new RegExp(`^opfs-orc-${args.stage}-[a-z0-9-]{1,60}$`, "u").test(args.name));
if (args.output === undefined) throw new TypeError("A new --output receipt directory is required.");
const image = args["image-id"], name = args.name, output = resolve(args.output);
mkdirSync(output);
const staging = mkdtempSync(join(tmpdir(), "opfs-orc-stage-"));
const commands: Record<string, unknown>[] = [];
let created = false;
/** Docker control diagnostics are bounded separately from the stage's attachment. */
function docker(label: string, argv: readonly string[]): string {
  const result = spawnSync("docker", argv, {
    timeout: 30_000,
    killSignal: "SIGKILL",
    maxBuffer: 4 * MIB,
    stdio: ["ignore", "pipe", "pipe"],
  });
  writeFileSync(join(output, `${label}.stdout`), result.stdout ?? "", { flag: "wx" });
  writeFileSync(join(output, `${label}.stderr`), result.stderr ?? "", { flag: "wx" });
  commands.push({ label, argv, code: result.status, error: result.error?.message, signal: result.signal });
  if (result.error !== undefined || result.status !== 0) throw new Error(`Docker ${label} failed.`);
  return result.stdout.toString();
}
function object(value: unknown): Record<string, unknown> {
  ok(typeof value === "object" && value !== null && !Array.isArray(value));
  return value as Record<string, unknown>;
}
function first(text: string): Record<string, unknown> {
  const value: unknown = JSON.parse(text);
  ok(Array.isArray(value) && value.length === 1);
  return object(value[0]);
}
let failure: string | null = null;
try {
  const inspected = first(docker("image-inspect", ["image", "inspect", image]));
  equal(inspected.Id, image);
  equal(inspected.Os, "linux");
  equal(inspected.Architecture, "arm64");
  if (args.stage === "install") {
    ok(
      Array.isArray(inspected.RepoDigests) &&
        inspected.RepoDigests.some((value: unknown) => typeof value === "string" && value.endsWith(`@${BASE}`)),
      "Install stage requires the pinned official Node base.",
    );
  }
  for (const folder of ["arrow", "orc"]) mkdirSync(join(staging, folder));
  for (const file of ["artifacts.ts", "files.ts", "admit.ts", "values.ts", "native.ts", "native.cpp", "runner.ts"]) {
    copyFileSync(fileURLToPath(new URL(`../arrow/${file}`, import.meta.url)), join(staging, "arrow", file));
  }
  for (const file of ["install.ts", "create.ts", "producer-run.ts"]) {
    copyFileSync(fileURLToPath(new URL(file, import.meta.url)), join(staging, "orc", file));
  }
  const entry = args.stage === "install"
    ? ["/fixture/orc/install.ts", "--receipts", "/receipts", "--output", "/tmp/orc-install"]
    : ["/fixture/orc/producer-run.ts", "--artifacts", "/tmp/orc-install", "--output", "/tmp/orc-native"];
  docker("create", [
    "create",
    "--pull",
    "never",
    "--name",
    name,
    "--network",
    "none",
    "--memory",
    "1g",
    "--memory-swap",
    "1g",
    "--cpus",
    "1",
    "--pids-limit",
    "128",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges=true",
    "--restart",
    "no",
    "--entrypoint",
    "/usr/local/bin/node",
    image,
    ...entry,
  ]);
  created = true;
  docker("copy-sources", ["cp", staging, `${name}:/fixture`]);
  if (args.stage === "install") {
    ok(args.receipts !== undefined);
    const root = resolve(args.receipts);
    const wheel = read(join(root, "arrow.whl"), 64 * MIB);
    equal(wheel.length, ARROW.bytes);
    equal(sha(wheel), ARROW.sha256);
    // Only the one admitted wheel enters this offline stage.
    const admitted = join(staging, "receipts");
    mkdirSync(admitted);
    writeFileSync(join(admitted, "arrow.whl"), wheel, { flag: "wx" });
    docker("copy-receipts", ["cp", admitted, `${name}:/receipts`]);
  }
  const state = first(docker("created-inspect", ["inspect", name])),
    host = object(state.HostConfig),
    config = object(state.Config),
    status = object(state.State);
  equal(state.Image, image);
  equal(config.Image, image);
  equal(status.Status, "created");
  equal(status.Running, false);
  equal(host.Memory, 1073741824);
  equal(host.MemorySwap, 1073741824);
  equal(host.NanoCpus, 1000000000);
  equal(host.PidsLimit, 128);
  equal(host.NetworkMode, "none");
  equal(host.Privileged, false);
  deepStrictEqual(host.CapDrop, ["ALL"]);
  ok(Array.isArray(host.SecurityOpt) && host.SecurityOpt.includes("no-new-privileges=true"));
  deepStrictEqual(state.Mounts, []);
  ok(
    !host.Binds && !host.CapAdd && !host.Devices && !host.DeviceRequests && !host.PortBindings && !config.Volumes &&
      !config.ExposedPorts,
  );
  equal(object(host.RestartPolicy).Name, "no");
  deepStrictEqual(config.Entrypoint, ["/usr/local/bin/node"]);
  deepStrictEqual(config.Cmd, entry);
  const attached = await supervise(["docker", "start", "-a", name], args.stage === "install" ? 150_000 : 210_000);
  writeFileSync(join(output, "attachment.log"), attached.output, { flag: "wx" });
  commands.push({ label: "attach", ...attached, output: undefined });
  if (attached.code !== 0 || attached.failure !== null || attached.cleanupFaults.length !== 0) {
    throw new Error("Attached native stage failed.");
  }
  const paths = args.stage === "install"
    ? ["/tmp/orc-install/admission.json"]
    : ["/tmp/orc-native/native-state.json", "/tmp/orc-native/native.log", "/tmp/orc-native/independent.json"];
  for (const [index, path] of paths.entries()) {
    docker(`copy-result-${index}`, ["cp", `${name}:${path}`, join(output, path.split("/").at(-1)!)]);
  }
} catch (error) {
  failure = String(error);
  if (created) {
    try {
      docker("stop", ["stop", "--time", "1", name]);
    } catch (cleanup) {
      failure += `; stop: ${String(cleanup)}`;
    }
  }
} finally {
  if (created) {
    try {
      const state = object(first(docker("final-inspect", ["inspect", name])).State);
      equal(state.Running, false);
      equal(state.OOMKilled, false);
      equal(state.ExitCode, 0);
    } catch (error) {
      failure = `${failure ?? ""}; final inspection: ${String(error)}`;
    }
  }
  writeFileSync(
    join(output, "launch.json"),
    JSON.stringify({ image, name, stage: args.stage, commands, failure }) + "\n",
    { flag: "wx" },
  );
  rmSync(staging, { recursive: true, force: true });
}
if (failure !== null) throw new Error(failure);
