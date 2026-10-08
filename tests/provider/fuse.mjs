/** Owns actual FUSE clients and isolated provider services; never mounts on the host. */
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { arch, cpus, platform } from "node:os";
import { validateMitata } from "../../bench/validate.ts";
import { inputs as identity, verifyInputs } from "../../bench/input.ts";
import { within } from "../gate.ts";
import { GenericContainer, Network, Wait } from "testcontainers";
import { BlobServiceClient, StorageSharedKeyCredential } from "@azure/storage-blob";
import {
  AZURE_ACCOUNT,
  AZURE_IMAGE,
  AZURE_KEY,
  S3_ACCESS_KEY,
  S3_IMAGE,
  S3_SECRET_KEY,
  STORAGE_NAME,
} from "./fixture.ts";

/** A failed acquisition retains evidence rather than disappearing before the first report write. */
const parent = ".tmp/reports/fuse";
await mkdir(parent, { recursive: true });
const directory = await mkdtemp(`${parent}/${new Date().toISOString().replaceAll(":", "-")}-`);
const metadata = {
  version: 2,
  status: "running",
  phase: "network",
  timestamp: new Date().toISOString(),
  host: { platform: platform(), arch: arch(), cpu: cpus()[0]?.model, node: process.versions.node },
  benchmarkRequested: process.env.OPFS_FUSE_BENCH === "1",
  workload: {
    backends: ["mountpoint", "blobfuse"],
    layers: ["raw", "driver", "adapter", "facade"],
    operations: ["create+stat", "read"],
  },
  payloadBytes: 256 * 1024,
  inputs: undefined,
  inputsAfter: undefined,
  containers: [],
  mounts: {},
  correctness: undefined,
  benchmark: undefined,
  versions: undefined,
  failure: undefined,
};
await save();
let network;
/** Membership, rather than an undefined sentinel, proves that even throw undefined failed. */
const failures = [];
let invalid = false;
const containers = [];
try {
  metadata.inputs = await identity();
  await save();
  network = await new Network().start();
  metadata.phase = "start-s3";
  await save();
  const s3 = await new GenericContainer(S3_IMAGE).withNetwork(network).withNetworkAliases("s3").withCommand([
    "mini",
    "-dir=/data",
  ]).withEnvironment({
    AWS_ACCESS_KEY_ID: S3_ACCESS_KEY,
    AWS_SECRET_ACCESS_KEY: S3_SECRET_KEY,
    S3_BUCKET: STORAGE_NAME,
  }).withExposedPorts(8333).withWaitStrategy(Wait.forListeningPorts()).withStartupTimeout(90000).start();
  containers.push(s3);
  await image("s3", s3);
  metadata.phase = "start-azure";
  await save();
  const azure = await new GenericContainer(AZURE_IMAGE).withNetwork(network).withNetworkAliases("azure").withCommand([
    "azurite-blob",
    "--blobHost",
    "0.0.0.0",
    "--skipApiVersionCheck",
    "--inMemoryPersistence",
  ]).withEnvironment({ AZURITE_ACCOUNTS: `${AZURE_ACCOUNT}:${AZURE_KEY}` }).withExposedPorts(10000).withWaitStrategy(
    Wait.forListeningPorts(),
  ).withStartupTimeout(90000).start();
  containers.push(azure);
  await image("azure", azure);
  await new BlobServiceClient(
    `http://${azure.getHost()}:${azure.getMappedPort(10000)}/${AZURE_ACCOUNT}`,
    new StorageSharedKeyCredential(AZURE_ACCOUNT, AZURE_KEY),
  ).getContainerClient(STORAGE_NAME).create();
  metadata.phase = "start-fuse";
  await save();
  const client = await new GenericContainer("opfs-reliability-fuse:1.24.0-2.5.5").withNetwork(network)
    .withPrivilegedMode().withBindMounts([{ source: process.cwd(), target: "/workspace", mode: "ro" }]).withEnvironment(
      {
        AWS_ACCESS_KEY_ID: S3_ACCESS_KEY,
        AWS_SECRET_ACCESS_KEY: S3_SECRET_KEY,
        AWS_REGION: "us-east-1",
        AWS_EC2_METADATA_DISABLED: "true",
      },
    ).withCommand(["sh", "-c", "echo FUSE_READY; sleep 3600"]).withWaitStrategy(Wait.forLogMessage("FUSE_READY"))
    .withStartupTimeout(90000).start();
  containers.push(client);
  await image("fuse", client);
  const configuration =
    `logging:\n  type: base\n  level: log_debug\n  file-path: /tmp/blobfuse.log\ncomponents:\n  - libfuse\n  - file_cache\n  - azstorage\nlibfuse:\n  attribute-expiration-sec: 0\n  entry-expiration-sec: 0\n  negative-entry-expiration-sec: 0\nfile_cache:\n  path: /tmp/blobcache\n  timeout-sec: 0\nazstorage:\n  type: block\n  account-name: ${AZURE_ACCOUNT}\n  account-key: ${AZURE_KEY}\n  container: ${STORAGE_NAME}\n  endpoint: http://azure:10000/${AZURE_ACCOUNT}\n  mode: key\n  use-http: true\n`;
  await client.copyContentToContainer([{ content: configuration, target: "/tmp/blobfuse.yaml" }]);
  metadata.phase = "mount";
  await save();
  const setup = await client.exec([
    "bash",
    "-c",
    "mkdir -p /mnt/s3 /mnt/azure /tmp/blobcache; mount-s3 opfs-test /mnt/s3 --endpoint-url http://s3:8333 --force-path-style --region us-east-1 --allow-delete --allow-overwrite --foreground >/tmp/mountpoint.log 2>&1 & blobfuse2 mount /mnt/azure --config-file=/tmp/blobfuse.yaml --foreground=true >/tmp/blobfuse-start.log 2>&1 & for i in $(seq 1 60); do if mountpoint -q /mnt/s3 && mountpoint -q /mnt/azure; then echo BOTH_MOUNTED; exit 0; fi; sleep 1; done; cat /tmp/mountpoint.log /tmp/blobfuse-start.log /tmp/blobfuse.log; exit 1",
  ]);
  console.log(JSON.stringify({ phase: "mount", exitCode: setup.exitCode, output: setup.output }));
  const mounted = await client.exec([
    "sh",
    "-c",
    "mountpoint -q /mnt/s3 && echo S3_MOUNTED; mountpoint -q /mnt/azure && echo AZURE_MOUNTED; mount-s3 --version; blobfuse2 --version; node --version",
  ]);
  console.log(mounted.output);
  metadata.versions = mounted.output;
  const environment = {};
  if (mounted.output.includes("S3_MOUNTED")) environment.OPFS_MOUNTPOINT_S3_ROOT = "/mnt/s3";
  if (mounted.output.includes("AZURE_MOUNTED")) environment.OPFS_BLOBFUSE_ROOT = "/mnt/azure";
  metadata.mounts = environment;
  if (setup.exitCode === 0 && Object.keys(environment).length === 2) {
    metadata.phase = "correctness";
    await save();
    // A failed cancellation oracle can leave its process waiting in close().
    // The deadline enters the owned-container finally path instead of waiting
    // for the fixture's hour-long idle command to exit.
    const command = await within(
      client.exec(["node", "tests/provider/fuse-client.mjs"], {
        workingDir: "/workspace",
        env: environment,
      }),
      "FUSE correctness command",
      120_000,
    );
    console.log(JSON.stringify({ phase: "correctness", exitCode: command.exitCode, output: command.output }));
    metadata.correctness = JSON.parse(command.output);
    if (
      command.exitCode !== 0 || !Array.isArray(metadata.correctness.results) || metadata.correctness.failures !== 0 ||
      !["mountpoint", "blobfuse"].every((name) =>
        metadata.correctness.results.some((row) => row.client === name && row.status === "pass")
      )
    ) throw new Error("FUSE correctness workflow failed or did not cover both mounted clients.");
    await save();
    if (process.env.OPFS_FUSE_BENCH === "1" && command.exitCode === 0) {
      metadata.phase = "benchmark";
      await save();
      const bench = await within(
        client.exec([
          "sh",
          "-c",
          "node --expose-gc bench/filesystem-provider.bench.ts >/tmp/fuse-bench.json 2>/tmp/fuse-bench.stderr",
        ], {
          workingDir: "/workspace",
          env: { ...environment, BENCH_JSON: "1" },
        }),
        "FUSE benchmark command",
        180_000,
      );
      const stdout = await client.exec(["cat", "/tmp/fuse-bench.json"]),
        stderr = await client.exec(["cat", "/tmp/fuse-bench.stderr"]);

      await writeFile(`${directory}/raw.json`, stdout.output);
      await writeFile(`${directory}/stderr.log`, stderr.output);
      metadata.benchmark = {
        exitCode: bench.exitCode,
        report: `${directory}/raw.json`,
        stderr: `${directory}/stderr.log`,
      };
      await save();
      if (bench.exitCode !== 0) throw new Error(`FUSE benchmark exited ${bench.exitCode}. See ${directory}.`);
      const value = JSON.parse(stdout.output);
      validateMitata(value);
      const expected = metadata.workload.backends.length * metadata.workload.layers.length *
        metadata.workload.operations.length;
      const measured = value.benchmarks.reduce((count, benchmark) => count + benchmark.runs.length, 0);
      if (measured !== expected) {
        throw new Error(`FUSE benchmark measured ${measured} cases, expected complete ${expected}-case workload.`);
      }
      metadata.benchmark.measuredRuns = measured;
      await save();
      console.log(
        JSON.stringify({ phase: "benchmark", exitCode: bench.exitCode, report: directory, stderr: stderr.output }),
      );
    }
  } else throw new Error("Both FUSE mounts must be ready; partial or absent coverage is a failure.");
  const logs = await client.exec([
    "sh",
    "-c",
    "tail -n 100 /tmp/mountpoint.log /tmp/blobfuse-start.log /tmp/blobfuse.log",
  ]);
  console.log(JSON.stringify({ phase: "client-logs", output: logs.output }));
} catch (error) {
  failures.push(error);
  metadata.failedPhase = metadata.phase;
  metadata.failure = error instanceof Error ? error.stack ?? error.message : String(error);
  metadata.status = "fail";
} finally {
  metadata.phase = "cleanup";
  await observeSave();
  for (const container of containers.toReversed()) {
    try {
      await container.stop();
    } catch (error) {
      failures.push(error);
    }
  }
  if (network) {
    try {
      await network.stop();
    } catch (error) {
      failures.push(error);
    }
  }
  try {
    metadata.inputsAfter = await identity();
    if (!metadata.inputs) {
      invalid = true;
      failures.push(new Error("FUSE input admission did not complete."));
    } else verifyInputs(metadata.inputs, metadata.inputsAfter);
  } catch (error) {
    invalid = true;
    failures.push(error);
  }
  metadata.status = invalid ? "invalid" : failures.length ? "fail" : "pass";
  if (failures.length) metadata.failure = { primary: metadata.failure, errors: failures.map(String) };
  metadata.phase = "complete";
  await observeSave();
  console.log(JSON.stringify({ phase: "complete", status: metadata.status, report: directory }));
}
if (failures.length) throw new AggregateError(failures, "FUSE workflow or evidence/cleanup failed.");

/** A diagnostic disk failure cannot skip owned cleanup or replace the original workflow reason. */
async function observeSave() {
  try {
    await save();
  } catch (error) {
    failures.push(error);
    metadata.status = invalid ? "invalid" : "fail";
    metadata.failure = { previous: metadata.failure, diagnosticErrors: failures.map(String) };
    console.error("FUSE metadata save failed:", error);
  }
}

/** Saves phase/failure progress even when Docker acquisition or mount setup does not complete. */
async function save() {
  await writeFile(`${directory}/metadata.json`, JSON.stringify(metadata, null, 2) + "\n");
}

/** Records content identity from the running container, not just the mutable requested image tag. */
async function image(name, container) {
  const run = promisify(execFile);
  const inspected = await run("docker", ["inspect", container.getId(), "--format", "{{json .}}"], { timeout: 10000 });
  const value = JSON.parse(inspected.stdout);
  if (value.Id !== container.getId()) throw new Error("Docker inspection did not match the actual started container.");
  const digests = await run("docker", ["image", "inspect", value.Image, "--format", "{{json .RepoDigests}}"], {
    timeout: 10000,
  });
  metadata.containers.push({
    name,
    id: container.getId(),
    requestedImage: value.Config.Image,
    imageId: value.Image,
    repoDigests: JSON.parse(digests.stdout) ?? [],
  });
  await save();
}
