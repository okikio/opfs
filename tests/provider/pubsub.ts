import { Buffer } from "node:buffer";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { close } from "../../src/close.ts";
import type { StartedTestContainer } from "testcontainers";

export const PUBSUB_IMAGE =
  "gcr.io/google.com/cloudsdktool/google-cloud-cli:592.0.0-emulators@sha256:c3b114528245d315af73d92d95d8e2fed9747ce29003ad46232f22b4542da036";
export const PUBSUB_ORACLE_IMAGE =
  "node:22.22.0-bookworm-slim@sha256:dd9d21971ec4395903fa6143c2b9267d048ae01ca6d3ea96f16cb30df6187d94";
const PROJECT = "opfs-pubsub";
const SDK_LOCK_SHA = "be831ae4d6d51f6db1cc66b0fc11db9da39f8ce07c4accf243f296d2946cfd45";
/** Disposable private emulator and isolated official SDK only; no host project, ADC or existing subscription is borrowed. */
export class PubsubFixture implements AsyncDisposable {
  readonly endpoint: string;
  readonly project = PROJECT;
  readonly topic = "events";
  readonly subscription = "events-sub";
  readonly #server: StartedTestContainer;
  readonly #oracle: StartedTestContainer;
  readonly #resources: readonly (() => Promise<unknown>)[];
  #closing: Promise<void> | undefined;
  constructor(
    server: StartedTestContainer,
    oracle: StartedTestContainer,
    resources: readonly (() => Promise<unknown>)[],
  ) {
    this.#server = server;
    this.#oracle = oracle;
    this.#resources = [...resources];
    this.endpoint = `http://${server.getHost()}:${server.getMappedPort(8085)}/`;
  }
  async #run(operation: "init" | "seed" | "pull"): Promise<unknown> {
    const result = await this.#oracle.exec(["timeout", "20", "node", "/oracle/oracle.ts", operation]);
    if (result.exitCode !== 0 || result.output.length > 2 * 1024 * 1024) {
      throw new Error("Independent Pub/Sub SDK failed.", { cause: result.output.slice(0, 65536) });
    }
    const lines = result.output.split(/\r?\n/u).filter((line) => line.startsWith("RECEIPT:"));
    if (lines.length !== 1) throw new Error("Independent Pub/Sub receipt is missing or duplicated.");
    return JSON.parse(lines[0]!.slice(8));
  }
  async init(): Promise<void> {
    const version = await this.#server.exec(["gcloud", "version", "--format=json"]);
    if (version.exitCode !== 0 || version.output.length > 65536) {
      throw new Error("Native emulator version query failed.");
    }
    const actual = JSON.parse(version.output);
    if (actual["Google Cloud SDK"] !== "592.0.0" || typeof actual["pubsub-emulator"] !== "string") {
      throw new Error("Native emulator component version differs.");
    }
    console.log(
      JSON.stringify({
        nativeVersion: actual["Google Cloud SDK"],
        pubsubEmulator: actual["pubsub-emulator"],
        sdk: await this.#run("init"),
      }),
    );
  }
  async seed(bytes: Uint8Array): Promise<readonly string[]> {
    if (bytes.length > 1048576) throw new RangeError("Independent Pub/Sub seed exceeds policy.");
    await this.#oracle.copyContentToContainer([{ content: Buffer.from(bytes), target: "/oracle/value.bin" }]);
    const result = await this.#run("seed");
    if (
      result === null || typeof result !== "object" || !("messageIds" in result) || !Array.isArray(result.messageIds) ||
      result.messageIds.length !== 1 || typeof result.messageIds[0] !== "string"
    ) throw new Error("Independent publish receipt differs.");
    return result.messageIds;
  }
  async pull(): Promise<{ readonly ackId: string; readonly messageId: string; readonly bytes: Uint8Array } | null> {
    const result = await this.#run("pull");
    if (
      result === null || typeof result !== "object" || !("receivedMessages" in result) ||
      !Array.isArray(result.receivedMessages) || result.receivedMessages.length > 1
    ) throw new Error("Independent pull receipt differs.");
    if (!result.receivedMessages.length) return null;
    const row: unknown = result.receivedMessages[0];
    if (
      row === null || typeof row !== "object" || !("ackId" in row) || typeof row.ackId !== "string" ||
      !("messageId" in row) || typeof row.messageId !== "string" || !("data" in row) || typeof row.data !== "string" ||
      row.data.length > 1398104
    ) throw new Error("Independent delivery receipt differs.");
    return { ackId: row.ackId, messageId: row.messageId, bytes: new Uint8Array(Buffer.from(row.data, "base64")) };
  }
  close(): Promise<void> {
    return this.#closing ??= close([...this.#resources].reverse());
  }
  [Symbol.asyncDispose](): Promise<void> {
    return this.close();
  }
}
/** Exact recipe requires separate acquisition/execution approval. PID limits and partial-start cleanup are owned before start can fail. */
export async function openPubsub(): Promise<PubsubFixture> {
  const packageBytes = await readFile(
    fileURLToPath(new URL("../fixtures/pubsub/sdk-package.json", import.meta.url).href),
  );
  const lockBytes = await readFile(fileURLToPath(new URL("../fixtures/pubsub/sdk-lock.json", import.meta.url).href));
  if (
    packageBytes.length > 4096 || lockBytes.length > 131072 ||
    createHash("sha256").update(lockBytes).digest("hex") !== SDK_LOCK_SHA
  ) throw new Error("Independent SDK manifest exceeds policy.");
  const manifest = JSON.parse(packageBytes.toString("utf8")), lock = JSON.parse(lockBytes.toString("utf8"));
  if (
    manifest.dependencies?.["@google-cloud/pubsub"] !== "6.3.2" || Object.keys(lock.packages).length !== 84 ||
    Object.values(lock.packages).some((value) => {
      if (value === null || typeof value !== "object" || !("resolved" in value)) return false;
      return typeof value.resolved !== "string" || !value.resolved.startsWith("https://registry.npmjs.org/") ||
        !("integrity" in value) || typeof value.integrity !== "string" || !value.integrity.startsWith("sha512-");
    })
  ) throw new Error("Independent SDK lock differs from the reviewed recipe.");
  console.log(JSON.stringify({ sdkLockSha256: createHash("sha256").update(lockBytes).digest("hex") }));
  const { GenericContainer, Network, Wait, getContainerRuntimeClient } = await import("testcontainers");
  const runtime = await getContainerRuntimeClient(), resources: (() => Promise<unknown>)[] = [], ids: string[] = [];
  class OwnedContainer extends GenericContainer {
    constructor(image: string, memory: number) {
      super(image);
      this.hostConfig.PidsLimit = 128;
      this.hostConfig.MemorySwap = memory;
    }
    protected override containerCreated(id: string): Promise<void> {
      ids.push(id);
      resources.push(async () => {
        try {
          await runtime.container.getById(id).remove({ force: true, v: true });
        } catch (reason) {
          if (reason === null || typeof reason !== "object" || !("statusCode" in reason) || reason.statusCode !== 404) {
            throw reason;
          }
        }
      });
      return Promise.resolve();
    }
  }
  try {
    const network = await new Network().start();
    resources.push(() => network.stop());
    const server = await new OwnedContainer(PUBSUB_IMAGE, 1073741824).withNetwork(network).withNetworkAliases(
      "pubsub.test",
    )
      .withExposedPorts(8085)
      .withEnvironment({
        CLOUDSDK_CORE_DISABLE_USAGE_REPORTING: "true",
        CLOUDSDK_COMPONENT_MANAGER_DISABLE_UPDATE_CHECK: "true",
        JAVA_TOOL_OPTIONS: "-Xms64m -Xmx512m",
      })
      .withCommand([
        "gcloud",
        "beta",
        "emulators",
        "pubsub",
        "start",
        "--project=opfs-pubsub",
        "--host-port=0.0.0.0:8085",
        "--quiet",
      ])
      .withResourcesQuota({ memory: 1, cpu: 1 }).withWaitStrategy(
        Wait.forLogMessage(/Server started, listening on 8085/u),
      ).withStartupTimeout(90000).start();
    resources.push(() => server.stop());
    const oracle = await new OwnedContainer(PUBSUB_ORACLE_IMAGE, 536870912).withNetwork(network).withWorkingDir(
      "/oracle",
    )
      .withEnvironment({ GCE_METADATA_DISABLED: "true", GOOGLE_CLOUD_PROJECT: PROJECT })
      .withCopyContentToContainer([{ content: packageBytes, target: "/oracle/package.json" }, {
        content: lockBytes,
        target: "/oracle/package-lock.json",
      }, {
        content: await readFile(fileURLToPath(new URL("../fixtures/pubsub/oracle.ts", import.meta.url).href)),
        target: "/oracle/oracle.ts",
      }])
      .withCommand([
        "sh",
        "-c",
        "timeout 120 npm ci --ignore-scripts --no-audit --no-fund --cache /tmp/npm-cache && touch /oracle/ready && exec sleep 600",
      ])
      .withResourcesQuota({ memory: 0.5, cpu: 0.5 }).withWaitStrategy(
        Wait.forSuccessfulCommand("test -f /oracle/ready"),
      ).withStartupTimeout(150000).start();
    resources.push(() => oracle.stop());
    for (
      const [container, memory, nanoCpus] of [[server, 1073741824, 1000000000], [oracle, 536870912, 500000000]] as const
    ) {
      const inspected: unknown = JSON.parse(
        execFileSync("docker", ["inspect", "--format", "{{json .}}", container.getId()], {
          encoding: "utf8",
          timeout: 10000,
          maxBuffer: 65536,
        }),
      );
      if (
        inspected === null || typeof inspected !== "object" || !("HostConfig" in inspected) ||
        !("Mounts" in inspected) || !Array.isArray(inspected.Mounts) || inspected.Mounts.length !== 0
      ) throw new Error("Actual Pub/Sub fixture has unexpected mounts/configuration.");
      const config = inspected.HostConfig;
      if (
        config === null || typeof config !== "object" || !("Memory" in config) || config.Memory !== memory ||
        !("MemorySwap" in config) || config.MemorySwap !== memory ||
        !("NanoCpus" in config) || config.NanoCpus !== nanoCpus || !("PidsLimit" in config) || config.PidsLimit !== 128
      ) throw new Error("Actual Pub/Sub fixture quota differs.");
      console.log(
        JSON.stringify({
          fixtureResource: container.getId(),
          memoryBytes: memory,
          memorySwapBytes: memory,
          nanoCpus,
          pidsLimit: 128,
          mounts: [],
        }),
      );
    }
    const fixture = new PubsubFixture(server, oracle, resources);
    await fixture.init();
    return fixture;
  } catch (reason) {
    for (const id of ids) {
      try {
        console.error(
          "Pub/Sub fixture bootstrap:",
          execFileSync("docker", ["logs", id], { encoding: "utf8", timeout: 10000, maxBuffer: 1048576 }),
        );
      } catch (failure) {
        console.error("Pub/Sub diagnostics unavailable:", failure);
      }
    }
    await close(resources.reverse(), [reason]);
    throw reason;
  }
}
