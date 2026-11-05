import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { arch } from "node:process";
import type { WaitStrategy } from "testcontainers";
import { createConnection } from "node:net";
import type { Socket } from "node:net";
import { close } from "../../src/close.ts";
import type { AmqpChannelType } from "../../src/amqp.ts";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { inflateRawSync } from "node:zlib";
import { openZip } from "../../src/archive/zip.ts";
import { readResponse } from "../../src/response.ts";
import { sourceRange } from "../../src/source.ts";
import { collectBytes } from "../../src/stream.ts";

// Test-only exact Pika wheel admission. Artifact inspection is not an AMQP
// wire oracle; the separately owned native SDK supplies that proof.
const WHEEL_SHA = "48de960c97a93b55db06b8be4c53eb977c9c8a2754c57cdae9097abcbd70ce04";
interface PikaOracleType {
  readonly bytes: Buffer;
  readonly dependencies: readonly string[];
  readonly members: readonly { readonly name: string; readonly size: number; readonly sha256?: string }[];
  readonly notices: readonly { readonly name: string; readonly base64: string; readonly sha256: string }[];
}
/** Acquisition/inspection only. Separate approval is required before downloading or importing this test-only SDK. */
export async function acquirePikaOracle(save?: (bytes: Uint8Array) => void): Promise<PikaOracleType> {
  const signal = AbortSignal.timeout(30_000);
  const response = await fetch(
    "https://files.pythonhosted.org/packages/7c/f3/921170b78779ac3f8b405cb28fce88acca1562ac114072cbf0a115e19bb9/pika-1.4.4-py3-none-any.whl",
    { signal, redirect: "error", credentials: "omit", referrerPolicy: "no-referrer" },
  );
  if (response.status !== 200 || response.body === null) {
    await readResponse(response, () => {
      throw new Error("Independent Pika wheel acquisition failed.");
    });
  }
  const bytes = await collectBytes(response.body!, 1048576, signal, "read", "Pika wheel");
  return await inspectPikaOracle(bytes, save);
}
/** Offline inspection of the exact already acquired artifact. No dependency/source import or SDK code execution occurs. */
export async function inspectPikaOracle(
  input: Uint8Array,
  save?: (bytes: Uint8Array) => void,
): Promise<PikaOracleType> {
  if (input.length !== 165275) throw new Error("Independent Pika wheel size differs from the pinned artifact.");
  const bytes = new Uint8Array(input);
  if (bytes.length !== 165275 || createHash("sha256").update(bytes).digest("hex") !== WHEEL_SHA) {
    throw new Error("Independent Pika wheel differs from the pinned artifact.");
  }
  // Save a detached copy only after raw identity admission, so diagnostics can reuse the exact artifact without another download.
  save?.(new Uint8Array(bytes));
  // Project ZIP is bounded acquisition tooling, not an independent Pika/AMQP oracle. Native zlib bounds each DEFLATE output.
  const archive = await openZip({
    size: bytes.length,
    stability: "immutable",
    read: async (at, length) => {
      sourceRange(bytes.length, at, length);
      return bytes.slice(at, at + length);
    },
  }, {
    maxEntries: 1024,
    maxDirectoryBytes: 524288,
    maxSourceBytes: 32 * 1048576,
    maxDecodedBytes: 8 * 1048576,
    maxOutputBytes: 8 * 1048576,
    maxRequests: 8192,
  });
  const members: { name: string; size: number; sha256?: string }[] = [], seen = new Set<string>();
  const notices: { name: string; base64: string; sha256: string }[] = [];
  let total = 0, metadata = false;
  let dependencies: string[] = [];
  for (const entry of archive.entries) {
    const name = entry.name.endsWith("/") ? entry.name.slice(0, -1) : entry.name;
    if (
      name.length > 4096 || name.startsWith("/") || name.includes("\\") ||
      [...name].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127) ||
      name.split("/").some((part) => part === "" || part === "." || part === "..") || seen.has(name) ||
      !(name === "pika" || name.startsWith("pika/") || name === "pika-1.4.4.dist-info" ||
        name.startsWith("pika-1.4.4.dist-info/")) ||
      entry.kind !== "file" && entry.kind !== "directory" || entry.encrypted || ![0, 8].includes(entry.method) ||
      entry.size > 1048576 || entry.kind === "directory" && entry.size !== 0
    ) throw new Error("Independent Pika wheel has unsupported members.");
    seen.add(name);
    total += entry.size;
    if (total > 8 * 1048576) throw new Error("Independent Pika expansion exceeds policy.");
    if (entry.kind === "directory") {
      members.push({ name, size: 0 });
      continue;
    }
    const result = await archive.read(entry.id, {
      verify: true,
      maxSourceBytes: 1048576,
      maxDecodedBytes: 1048576,
      maxOutputBytes: 1048576,
      maxRequests: 64,
      inflate: () => {
        const chunks: Buffer[] = [];
        let length = 0;
        return new TransformStream<Uint8Array, Uint8Array>({
          transform(chunk) {
            length += chunk.length;
            if (length > 1048576) throw new Error("Independent wheel DEFLATE input exceeds policy.");
            chunks.push(Buffer.from(chunk));
          },
          flush(controller) {
            controller.enqueue(new Uint8Array(inflateRawSync(Buffer.concat(chunks), { maxOutputLength: 1048576 })));
          },
        });
      },
    });
    if (result.integrity !== "checksum-verified") throw new Error("Independent wheel lacks a CRC check.");
    const hash = createHash("sha256").update(result.bytes).digest("hex");
    members.push({ name, size: result.bytes.length, sha256: hash });
    if (/(?:^|\/)(?:LICENSE|LICENCE|NOTICE|COPYING|COPYRIGHT)(?:[._-].*)?$/iu.test(name)) {
      notices.push({ name, base64: Buffer.from(result.bytes).toString("base64"), sha256: hash });
    }
    if (name === "pika-1.4.4.dist-info/METADATA") {
      const content = new TextDecoder("utf-8", { fatal: true }).decode(result.bytes);
      if (!/^Name: pika$/mu.test(content) || !/^Version: 1\.4\.4$/mu.test(content)) {
        throw new Error("Independent wheel identity differs.");
      }
      // Acquisition remains inert: record exact raw metadata spelling for root
      // review before any install. Registry metadata is not an installed-wheel
      // dependency authority, and this is not a partial PEP508 interpreter.
      dependencies = content.split("\n").filter((line) => line.startsWith("Requires-Dist:"));
      metadata = true;
    }
  }
  if (!metadata || notices.length === 0) throw new Error("Independent wheel metadata or notices are missing.");
  return { bytes: Buffer.from(bytes), members, notices, dependencies };
}

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
const PYTHON = "python:3.13.12-slim-bookworm@sha256:a58daefb915e1e03ad48f3ca4df8832065412c5c35cacb9d39f4229184de12b6";
const SHA = "48de960c97a93b55db06b8be4c53eb977c9c8a2754c57cdae9097abcbd70ce04";
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
const ORACLE = `import sys,base64,json,importlib.metadata
from pathlib import Path
if sys.version_info[:3]!=(3,13,12):raise RuntimeError('independent Python version differs')
if importlib.metadata.version('pika')!='1.4.4':raise RuntimeError('independent Pika version differs')
import pika
connection=pika.BlockingConnection(pika.ConnectionParameters(host='amqp.test',port=5672,virtual_host='/owned',credentials=pika.PlainCredentials('fixture','fixture-only-amqp'),heartbeat=60,channel_max=1,frame_max=65536,socket_timeout=5,stack_timeout=10,blocked_connection_timeout=5,connection_attempts=1,retry_delay=0))
failure=None
try:
 channel=connection.channel()
 op=sys.argv[1]
 if op=='init':
  channel.exchange_declare(exchange='owned',exchange_type='direct',durable=False,auto_delete=False)
  # RabbitMQ4.4 refuses deprecated nonexclusive transient queues by default.
  # Durable topology stays disposable because all broker data is owned tmpfs.
  channel.queue_declare(queue='owned',durable=True,exclusive=False,auto_delete=False,arguments={'x-max-length-bytes':1048576,'x-max-length':64})
  channel.queue_bind(queue='owned',exchange='owned',routing_key='key')
  properties=connection._impl.server_properties
  if properties.get('version')!='4.4.0':raise RuntimeError('native RabbitMQ version differs')
  result={'sdk':importlib.metadata.version('pika'),'python':sys.version.split()[0],'serverVersion':properties.get('version'),'platform':properties.get('platform'),'publisherConfirms':connection.publisher_confirms_supported}
 elif op=='seed':
  data=Path('/oracle/value.bin').read_bytes()
  if len(data)>1048576:raise RuntimeError('independent bytes exceed policy')
  channel.confirm_delivery()
  channel.basic_publish(exchange='owned',routing_key='key',body=data,mandatory=True)
  result={'confirmed':True,'bytes':len(data)}
 elif op=='take':
  method,properties,data=channel.basic_get(queue='owned',auto_ack=True)
  if method is None:result={'empty':True}
  else:
   if len(data)>1048576:raise RuntimeError('independent bytes exceed policy')
   result={'empty':False,'base64':base64.b64encode(data).decode('ascii'),'deliveryTag':str(method.delivery_tag),'redelivered':method.redelivered,'messageCount':str(method.message_count)}
 elif op=='count':
  status=channel.queue_declare(queue='owned',passive=True)
  result={'messages':str(status.method.message_count)}
 else:raise RuntimeError('unsupported independent operation')
 print('RECEIPT:'+json.dumps(result,separators=(',',':')))
except BaseException as reason:
 failure=reason
 raise
finally:
 try:connection.close()
 except BaseException as cleanup:
  if failure is not None:raise BaseExceptionGroup('Independent SDK operation and cleanup failed',[failure,cleanup])
  raise
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
/** Source-only reviewed recipe: caller must obtain separate native GO first. */
export async function withAmqpFixture<T>(
  admittedWheel: Uint8Array | undefined,
  body: (fixture: AmqpFixtureType) => Promise<T>,
): Promise<T> {
  const acquired = admittedWheel === undefined ? await acquirePikaOracle() : await inspectPikaOracle(admittedWheel);
  const reviewedRawDependencies = [
    'Requires-Dist: gevent; extra == "gevent"',
    'Requires-Dist: tornado; extra == "tornado"',
    'Requires-Dist: twisted; extra == "twisted"',
  ];
  if (
    acquired.dependencies.length !== reviewedRawDependencies.length ||
    acquired.dependencies.some((line, index) => line !== reviewedRawDependencies[index])
  ) throw new Error("Actual Pika raw dependency profile is not the reviewed one.");
  const tool = JSON.parse(readFileSync(createRequire(import.meta.url).resolve("testcontainers/package.json"), "utf8"));
  if (tool.version !== "12.1.0") throw new Error("Native AMQP fixture requires reviewed Testcontainers12.1.0.");
  console.log(JSON.stringify({ testcontainersVersion: tool.version }));
  const architecture = arch === "arm64" ? "arm64" : arch === "x64" ? "amd64" : undefined;
  if (architecture === undefined) throw new Error("Native AMQP fixture supports only explicit arm64 or x64 hosts.");
  const imageIds = new Map<boolean, string>();
  for (const [server, reference] of [[true, SERVER], [false, PYTHON]] as const) {
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
  const { GenericContainer, Network, Wait, getContainerRuntimeClient } = await import("testcontainers");
  const runtime = await getContainerRuntimeClient(), releases: (() => Promise<unknown>)[] = [], ids: string[] = [];
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
      value.image !== imageIds.get(server) || value.config.Image !== (server ? SERVER : PYTHON) ||
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
    const oracle = await new OwnedContainer(PYTHON, false).withNetwork(network).withCopyContentToContainer([
      { target: "/oracle/pika-1.4.4-py3-none-any.whl", content: acquired.bytes },
      { target: "/oracle/requirements.txt", content: `/oracle/pika-1.4.4-py3-none-any.whl --hash=sha256:${SHA}\n` },
      { target: "/oracle/oracle.py", content: ORACLE },
    ]).withCommand([
      "sh",
      "-c",
      "timeout 45 python -I -m pip install --no-index --no-deps --require-hashes --no-compile --disable-pip-version-check -r /oracle/requirements.txt && touch /oracle/ready && exec sleep 600",
    ])
      .withResourcesQuota({ memory: 0.25, cpu: 0.5 }).withWaitStrategy(
        diagnose(Wait.forSuccessfulCommand("test -f /oracle/ready")),
      ).withStartupTimeout(60_000).start();
    releases.push(() => oracle.stop({ remove: false, timeout: 5000 }));
    inspect(oracle.getId(), false, false);
    const run = async function run(operation: "init" | "seed" | "take" | "count"): Promise<Record<string, unknown>> {
      const result = await oracle.exec(["timeout", "20", "python", "-I", "/oracle/oracle.py", operation]);
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
        await oracle.copyContentToContainer([{ content: bytes, target: "/oracle/value.bin" }]);
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
