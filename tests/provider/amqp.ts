import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { arch } from "node:process";
import type { WaitStrategy } from "testcontainers";
import { createConnection } from "node:net";
import type { Socket } from "node:net";
import { close } from "../../src/close.ts";
import type { AmqpChannelType } from "../../src/amqp.ts";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";

import { fileURLToPath } from "node:url";

function retire(socket: Socket): Promise<void> {
  if (socket.closed) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const ended = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      socket.off("close", ended);
      reject(new Error("Owned AMQP fixture socket close deadline."));
    }, 5000);
    socket.once("close", ended);
    socket.destroy();
  });
}
/** Test-only socket transport bounds chunks without changing any native command/reply bytes. It makes no TLS proof. */
function wrap(socket: Socket, retired: () => void): AmqpChannelType {
  let closing: Promise<void> | undefined;
  return {
    security: "plaintext",
    readable: new ReadableStream<Uint8Array>({
      pull(controller) {
        return new Promise<void>((resolve, reject) => {
          const clean = () => {
            socket.off("readable", read);
            socket.off("end", read);
            socket.off("close", read);
            socket.off("error", error);
          };
          const error = (reason: Error) => {
            clean();
            reject(reason);
          };
          const read = () => {
            const bytes: unknown = socket.read(Math.min(65536, socket.readableLength));
            if (bytes instanceof Uint8Array && bytes.length) {
              clean();
              controller.enqueue(new Uint8Array(bytes));
              resolve();
            } else if (socket.readableEnded) {
              clean();
              controller.close();
              resolve();
            } else if (socket.destroyed) error(new Error("Owned AMQP fixture socket closed."));
          };
          socket.on("readable", read);
          socket.once("end", read);
          socket.once("close", read);
          socket.once("error", error);
          read();
        });
      },
      cancel() {
        socket.destroy();
      },
    }, { highWaterMark: 0 }),
    writable: new WritableStream<Uint8Array>({
      write(bytes) {
        return new Promise<void>((resolve, reject) => {
          socket.write(bytes, (reason) => reason ? reject(reason) : resolve());
        });
      },
      abort() {
        socket.destroy();
      },
    }),
    close() {
      return closing ??= retire(socket).then(retired);
    },
  };
}
/** This fixture adapter is plaintext only and does not qualify TLS or certificate checks. */
async function connect(
  host: string,
  port: number,
  signal: AbortSignal,
  sockets: Set<Socket>,
): Promise<AmqpChannelType> {
  signal.throwIfAborted();
  const socket = createConnection({ host, port });
  socket.on("error", () => {});
  sockets.add(socket);
  try {
    await new Promise<void>((resolve, reject) => {
      const clean = () => {
        socket.off("connect", ready);
        socket.off("error", error);
        signal.removeEventListener("abort", abort);
      };
      const ready = () => {
        clean();
        resolve();
      };
      const error = (reason: unknown) => {
        clean();
        reject(reason);
      };
      const abort = () => {
        socket.destroy();
        error(signal.reason);
      };
      socket.once("connect", ready);
      socket.once("error", error);
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
    });
    signal.throwIfAborted();
    return wrap(socket, () => sockets.delete(socket));
  } catch (reason) {
    sockets.delete(socket);
    await close([() => retire(socket)], [reason]);
    throw reason;
  }
}

const SERVER = "rabbitmq:4.4.0@sha256:485319d42170eab53d8a030e1cc49d95e41f5d325479fa504736db8091981eb7";
const NODE = "node:26.13.0-bookworm-slim@sha256:add5c17c14752c54d2f3d519ec46a3815684d41c33f198bcb09fb998f7dcbf68";
const LABEL = "amqp-native-20261105-implement-gcs";
const DATA = "rw,noexec,nosuid,size=64m,mode=0777";
const CONFIG = `listeners.tcp.default = 5672
default_user = fixture
default_pass = fixture-only-amqp
default_vhost = /owned
heartbeat = 60
frame_max = 65536
channel_max = 1
vm_memory_high_watermark.absolute = 256MiB
disk_free_limit.absolute = 8MiB
log.console = true
log.console.level = info
`;
export interface AmqpFixtureType {
  readonly host: string;
  readonly port: number;
  readonly auth: { readonly user: "fixture"; readonly password: "fixture-only-amqp" };
  readonly vhost: "/owned";
  openChannel(options: { readonly signal: AbortSignal }): Promise<AmqpChannelType>;
  seed(bytes: Uint8Array): Promise<Record<string, unknown>>;
  take(): Promise<Record<string, unknown>>;
  count(): Promise<Record<string, unknown>>;
}
/** Acquires the pinned native fixture and retires its private containers and network after the test. */
export async function withAmqpFixture<T>(
  body: (fixture: AmqpFixtureType) => Promise<T>,
): Promise<T> {
  const tool = JSON.parse(readFileSync(createRequire(import.meta.url).resolve("testcontainers/package.json"), "utf8"));
  if (tool.version !== "12.1.0") throw new Error("Native AMQP fixture requires reviewed Testcontainers12.1.0.");
  console.log(JSON.stringify({ testcontainersVersion: tool.version }));
  const architecture = arch === "arm64" ? "arm64" : arch === "x64" ? "amd64" : undefined;
  if (architecture === undefined) throw new Error("Native AMQP fixture supports only explicit arm64 or x64 hosts.");
  const { GenericContainer, ImageName, Network, Wait, getContainerRuntimeClient } = await import("testcontainers");
  const runtime = await getContainerRuntimeClient(), releases: (() => Promise<unknown>)[] = [], ids: string[] = [];
  const imageIds = new Map<boolean, string>();
  for (const [server, reference] of [[true, SERVER], [false, NODE]] as const) {
    // A fresh CI host has no cached images. Acquisition must finish before
    // immutable-image admission, which still runs before any container starts.
    await runtime.image.pull(ImageName.fromString(reference), { force: false, platform: `linux/${architecture}` });
    const image = JSON.parse(
      execFileSync("docker", ["image", "inspect", reference], {
        encoding: "utf8",
        timeout: 10000,
        maxBuffer: 262144,
      }),
    )[0];
    console.log(JSON.stringify({ phase: "immutable-image-admission", reference, image }));
    if (
      !/^sha256:[0-9a-f]{64}$/u.test(image.Id) || image.Os !== "linux" || image.Architecture !== architecture ||
      !Array.isArray(image.RepoDigests) || !image.RepoDigests.some((digest: string) =>
        digest.endsWith("@" + reference.split("@")[1])
      )
    ) throw new Error("Native AMQP image identity/platform differs.");
    imageIds.set(server, image.Id);
  }
  const context = fileURLToPath(new URL("../fixtures/amqp/", import.meta.url).href);
  const sourceHash = createHash("sha256");
  for (const file of ["native.c", "client.ts", "Dockerfile"]) {
    const path = context + "/" + file, info = lstatSync(path);
    if (!info.isFile() || info.size > 1048576) throw new Error("Native AMQP source exceeds its regular-file budget.");
    sourceHash.update(readFileSync(path));
  }
  const sourceDigest = sourceHash.digest("hex");
  const tag = `opfs-amqp-native:${sourceDigest.slice(0, 24)}`;
  await GenericContainer.fromDockerfile(context).build(tag);
  const derived = JSON.parse(
    execFileSync("docker", ["image", "inspect", tag], { encoding: "utf8", timeout: 10000, maxBuffer: 262144 }),
  )[0];
  if (!/^sha256:[0-9a-f]{64}$/u.test(derived.Id) || derived.Os !== "linux" || derived.Architecture !== architecture) {
    throw new Error("Derived native SDK image identity/platform differs.");
  }
  console.log(JSON.stringify({ phase: "derived-native-sdk-image", sourceDigest, image: derived }));
  const oracleReference: string = derived.Id;
  imageIds.set(false, oracleReference);
  let networkId: string | undefined, networkName: string | undefined;
  function inspect(id: string, server: boolean, created: boolean): void {
    const text = execFileSync("docker", [
      "inspect",
      "--format",
      '{"host":{{json .HostConfig}},"mounts":{{json .Mounts}},"state":{{json .State}},"image":{{json .Image}},"config":{{json .Config}},"networks":{{json .NetworkSettings.Networks}},"ports":{{json .NetworkSettings.Ports}}}',
      id,
    ], { encoding: "utf8", timeout: 10000, maxBuffer: 131072 });
    const value = JSON.parse(text), memory = server ? 536870912 : 268435456;
    console.log(JSON.stringify({ phase: created ? "created-before-start" : "started", id, ...value }));
    const host = value.host, bindings = host.PortBindings ?? {}, keys = Object.keys(bindings);
    const published = Object.entries(value.ports ?? {}).filter(([, bindings]) =>
      Array.isArray(bindings) && bindings.length > 0
    ).map(([key]) => key);
    const allowedNetworks = ["default", "bridge", networkId, networkName];
    if (
      host.Privileged || host.CapAdd?.length || host.Devices?.length || host.DeviceRequests?.length ||
      host.ExtraHosts?.length || host.PublishAllPorts || host.IpcMode === "host" ||
      !allowedNetworks.includes(host.NetworkMode)
    ) throw new Error("Native AMQP fixture isolation differs.");
    // Docker records configured endpoints before assigning their network IDs.
    // Only that created state may omit the ID; a running fixture must prove it.
    const endpoints = value.networks ?? {}, endpoint = networkName ? endpoints[networkName] : undefined;
    if (
      !networkName || !networkId || !endpoint ||
      Object.keys(endpoints).some((name) => name !== networkName && name !== "bridge") ||
      (created ? endpoint.NetworkID !== "" && endpoint.NetworkID !== networkId : endpoint.NetworkID !== networkId)
    ) throw new Error("Native AMQP fixture is not attached to its owned network.");
    if (server) {
      if (
        keys.length !== 1 || keys[0] !== "5672/tcp" || !Array.isArray(bindings["5672/tcp"]) ||
        bindings["5672/tcp"].length !== 1 || created && bindings["5672/tcp"][0].HostPort !== "0" ||
        published.some((key) => key !== "5672/tcp") || !created && published.length !== 1
      ) throw new Error("Native AMQP server published unexpected ports.");
    } else if (keys.length || published.length) throw new Error("Native AMQP oracle must not publish host ports.");
    if (
      !server && (value.config.User !== "65534:65534" || !host.CapDrop?.includes("ALL") ||
        !host.SecurityOpt?.some((value: string) => value === "no-new-privileges" || value === "no-new-privileges=true"))
    ) {
      throw new Error("Native AMQP SDK requires its nonroot, drop-all, no-new-privileges profile.");
    }
    if (
      value.image !== imageIds.get(server) || value.config.Image !== (server ? SERVER : oracleReference) ||
      value.state.OOMKilled || created && (value.state.Status !== "created" || value.state.Running) ||
      value.host.Memory !== memory || value.host.MemorySwap !== memory || value.host.NanoCpus !== 500000000 ||
      value.host.PidsLimit !== 128 || value.host.Binds?.length || !Array.isArray(value.mounts) ||
      value.mounts.some((mount: { Type: string; Destination: string }) =>
        !server || mount.Type !== "tmpfs" || mount.Destination !== "/var/lib/rabbitmq"
      ) || server && value.host.Tmpfs?.["/var/lib/rabbitmq"] !== DATA
    ) throw new Error("Actual native AMQP fixture resource admission differs.");
  }
  class OwnedContainer extends GenericContainer {
    readonly #server: boolean;
    constructor(image: string, server: boolean) {
      super(image);
      this.#server = server;
      this.hostConfig.PidsLimit = 128;
      this.hostConfig.MemorySwap = server ? 536870912 : 268435456;
      this.withLabels({ "opfs.fixture": LABEL });
    }
    protected override containerCreated(id: string): Promise<void> {
      ids.push(id);
      // Registration precedes inspection and engine start, including failures.
      releases.push(async () => {
        const owned = runtime.container.getById(id);
        await close([
          async () => {
            try {
              const state = await owned.inspect();
              console.log(JSON.stringify({ phase: "before-owned-removal", id, state }));
              if (state.State.OOMKilled) throw new Error("Native AMQP fixture was OOM-killed.");
            } catch (reason) {
              if (
                reason === null || typeof reason !== "object" || !("statusCode" in reason) || reason.statusCode !== 404
              ) throw reason;
              console.log(JSON.stringify({ phase: "already-removed-before-owned-cleanup", id }));
            }
          },
          async () => {
            try {
              await owned.remove({ force: true, v: true });
            } catch (reason) {
              if (
                reason === null || typeof reason !== "object" || !("statusCode" in reason) || reason.statusCode !== 404
              ) throw reason;
            }
          },
        ]);
      });
      inspect(id, this.#server, true);
      return Promise.resolve();
    }
  }
  const failures: unknown[] = [];
  // Testcontainers removes a failed startup before start() rejects. Capture the
  // actual state and bounded logs inside its wait boundary, while they exist.
  function diagnose(wait: WaitStrategy): WaitStrategy {
    return {
      withStartupTimeout(ms) {
        wait.withStartupTimeout(ms);
        return this;
      },
      isStartupTimeoutSet: () => wait.isStartupTimeoutSet(),
      getStartupTimeout: () => wait.getStartupTimeout(),
      async waitUntilReady(container, ports, start) {
        try {
          await wait.waitUntilReady(container, ports, start);
        } catch (reason) {
          for (const args of [["inspect", container.id], ["logs", "--tail", "120", container.id]]) {
            try {
              console.error(execFileSync("docker", args, { timeout: 10000, maxBuffer: 262144, encoding: "utf8" }));
            } catch (diagnostic) {
              console.error("Owned AMQP readiness diagnostic failed", diagnostic);
            }
          }
          throw reason;
        }
      },
    };
  }
  try {
    const network = await new Network().start();
    releases.push(() => network.stop());
    networkId = network.getId();
    networkName = network.getName();
    console.log(JSON.stringify({ phase: "owned-network", id: network.getId(), name: network.getName() }));
    const server = await new OwnedContainer(SERVER, true).withNetwork(network).withNetworkAliases("amqp.test")
      .withCopyContentToContainer([{ target: "/etc/rabbitmq/rabbitmq.conf", content: CONFIG }])
      .withTmpFs({ "/var/lib/rabbitmq": DATA })
      .withEnvironment({ RABBITMQ_SERVER_ADDITIONAL_ERL_ARGS: "+S 1:1 +SDcpu 1:1 +SDio 1 +A 1" })
      .withExposedPorts(5672).withResourcesQuota({ memory: 0.5, cpu: 0.5 })
      // Use the image's own privilege drop for the CLI probe too. A root
      // diagnostic can create a cookie that the rabbitmq server cannot read.
      .withWaitStrategy(
        diagnose(
          Wait.forAll([
            Wait.forSuccessfulCommand("docker-entrypoint.sh rabbitmq-diagnostics -q ping"),
            Wait.forListeningPorts(),
          ]),
        ),
      ).withStartupTimeout(90_000).start();
    releases.push(() => server.stop({ remove: false, timeout: 5000 }));
    inspect(server.getId(), true, false);
    const oracle = await new OwnedContainer(oracleReference, false).withNetwork(network)
      .withDroppedCapabilities("ALL").withSecurityOpt("no-new-privileges")
      .withResourcesQuota({ memory: 0.25, cpu: 0.5 }).withWaitStrategy(diagnose(Wait.forLogMessage("ORACLE_READY")))
      .withStartupTimeout(60_000).start();
    releases.push(() => oracle.stop({ remove: false, timeout: 5000 }));
    inspect(oracle.getId(), false, false);
    const admission = await oracle.exec(["timeout", "--signal=KILL", "10", "node", "/oracle/client.ts", "inspect"]);
    if (admission.exitCode !== 0 || admission.output.length > 1048576) {
      throw new Error("Native AMQP SDK admission receipt failed.");
    }
    console.log(
      JSON.stringify({ phase: "native-sdk-packages-and-sources", receipt: JSON.parse(admission.output) as unknown }),
    );
    const run = async function run(operation: "init" | "seed" | "take" | "count"): Promise<Record<string, unknown>> {
      const result = await oracle.exec(["timeout", "--signal=KILL", "20", "node", "/oracle/client.ts", operation]);
      if (result.exitCode !== 0 || result.output.length > 2 * 1048576) {
        throw new Error("Independent AMQP operation failed.", { cause: result.output.slice(0, 65536) });
      }
      const lines = result.output.split(/\r?\n/u).filter((line) => line.startsWith("RECEIPT:"));
      if (lines.length !== 1) throw new Error("Independent AMQP receipt is missing or duplicated.");
      const value: unknown = JSON.parse(lines[0]!.slice(8));
      if (value === null || typeof value !== "object" || Array.isArray(value)) {
        throw new Error("Independent AMQP receipt has invalid shape.");
      }
      return value as Record<string, unknown>;
    };
    console.log(JSON.stringify({ native: await run("init") }));
    const sockets = new Set<Socket>();
    releases.push(() => close([...sockets].map((socket) => () => retire(socket))));
    return await body({
      openChannel: ({ signal }) => connect(server.getHost(), server.getMappedPort(5672), signal, sockets),
      host: server.getHost(),
      port: server.getMappedPort(5672),
      auth: { user: "fixture", password: "fixture-only-amqp" },
      vhost: "/owned",
      seed: async (input) => {
        if (input.length > 1048576) throw new Error("Independent fixture input exceeds policy.");
        const bytes = Buffer.from(input);
        await oracle.copyContentToContainer([{ content: bytes, target: "/oracle/value.bin", mode: 0o644 }]);
        return await run("seed");
      },
      take: () => run("take"),
      count: () => run("count"),
    });
  } catch (reason) {
    failures.push(reason);
    for (const id of ids) {
      try {
        console.error(
          execFileSync("docker", ["logs", "--tail", "120", id], {
            timeout: 10000,
            maxBuffer: 1048576,
            encoding: "utf8",
          }),
        );
      } catch (diagnostic) {
        console.error("Owned AMQP bootstrap diagnostic failed", diagnostic);
      }
    }
    throw reason;
  } finally {
    await close(releases.toReversed(), failures);
  }
}
