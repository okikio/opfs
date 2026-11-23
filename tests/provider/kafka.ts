/** Owned native Kafka fixture for Metadata observations; no production client or leader routing. */
import { Buffer } from "node:buffer";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { close } from "../../src/close.ts";
import type { StartedTestContainer, WaitStrategy } from "testcontainers";

export const KAFKA_IMAGE = "apache/kafka@sha256:77b56ddfb7104fc5814a3d0127fcff49983220c7c7ad9bfc1f0af4d439228329";
const MIB = 1048576;
const TMPFS = {
  "/var/lib/kafka/data": "rw,noexec,nosuid,size=32m,mode=0777",
  "/tmp": "rw,noexec,nosuid,size=8m,mode=1777",
  "/opt/kafka/logs": "rw,noexec,nosuid,size=1m,mode=0777",
  "/etc/kafka/secrets": "rw,noexec,nosuid,size=64k,mode=0777",
  "/mnt/shared/config": "rw,noexec,nosuid,size=64k,mode=0777",
} as const;
/** Exact five-JAR closure admitted in the retained native artifact review. No broker classpath is substituted. */
const JARS = [
  ["kafka-clients-4.4.0.jar", 10925782, "9e4514622675f9b24c83373d0d5b35dd7a4dba34bad69762fe90a9e54cfb71de"],
  ["lz4-java-1.11.2.jar", 897831, "8a7458657938e9b692224db83aac458c13abd7a59ab75c3d3b08bd2233a646a2"],
  ["slf4j-api-1.7.36.jar", 41125, "d3ef575e3e4979678dc01bf1dcce51021493b4d11fb7f1be8ad982877c16a1c0"],
  ["snappy-java-1.1.10.7.jar", 2338496, "4c766cb3f855415ee734b2392949a0b6f12a60879334a74518deaf6270d32e36"],
  ["zstd-jni-1.5.7-17.jar", 6323239, "c9043e2da8a16c13b6cd7661a5cb56685a573c3546ef4bd0ead67b0b67c2e107"],
] as const;
const CONFIG = `process.roles=broker,controller
node.id=1
controller.quorum.voters=1@127.0.0.1:9093
listeners=INTERNAL://0.0.0.0:9092,CONTROLLER://127.0.0.1:9093
advertised.listeners=INTERNAL://127.0.0.1:9092
listener.security.protocol.map=INTERNAL:PLAINTEXT,CONTROLLER:PLAINTEXT
inter.broker.listener.name=INTERNAL
controller.listener.names=CONTROLLER
log.dirs=/var/lib/kafka/data
num.partitions=1
auto.create.topics.enable=false
num.network.threads=1
num.io.threads=2
num.recovery.threads.per.data.dir=1
socket.request.max.bytes=4194304
message.max.bytes=2097152
replica.fetch.max.bytes=2097152
log.segment.bytes=1048576
log.index.size.max.bytes=1048576
metadata.log.segment.bytes=8388608
log.retention.bytes=4194304
log.retention.ms=3600000
log.message.timestamp.before.max.ms=9223372036854775807
log.message.timestamp.after.max.ms=9223372036854775807
log.message.timestamp.type=CreateTime
offsets.topic.replication.factor=1
transaction.state.log.replication.factor=1
transaction.state.log.min.isr=1
group.initial.rebalance.delay.ms=0
`;
const LOGGING = `status=error
name=OwnedKafkaConsole
appender.console.type=Console
appender.console.name=CONSOLE
appender.console.layout.type=PatternLayout
appender.console.layout.pattern=%m%n
rootLogger.level=info
rootLogger.appenderRef.console.ref=CONSOLE
`;
/** Remove inherited proxy, credential and JVM options before invoking native programs. */
function environment(heap: string): string[] {
  return [
    "/usr/bin/env",
    "-i",
    "PATH=/opt/java/openjdk/bin:/opt/kafka/bin:/usr/bin:/bin",
    "HOME=/tmp",
    "LANG=C.UTF-8",
    "LC_ALL=C.UTF-8",
    `KAFKA_HEAP_OPTS=${heap}`,
    "KAFKA_JVM_PERFORMANCE_OPTS=-XX:ActiveProcessorCount=1",
    "KAFKA_LOG4J_OPTS=-Dlog4j2.configurationFile=/fixture/log4j2.properties",
  ];
}
/** Normalize kernel size= suffixes to bytes; percentages or implicit defaults cannot prove an exact ceiling. */
function mountSize(value: string): bigint {
  const match = /^([0-9]+)([kmg]?)$/iu.exec(value);
  if (!match) throw new Error("Kafka kernel tmpfs size is not an explicit admitted byte ceiling.");
  const units = { "": 1n, k: 1024n, m: 1048576n, g: 1073741824n } as const;
  const suffix = match[2]!.toLowerCase();
  if (suffix !== "" && suffix !== "k" && suffix !== "m" && suffix !== "g") {
    throw new Error("Kafka tmpfs size suffix differs.");
  }
  return BigInt(match[1]!) * units[suffix];
}
/** Verify actual kernel mounts independently of Docker Engine's optional Mounts summary. */
function kernelMounts(
  text: string,
): readonly { readonly path: string; readonly sizeBytes: string; readonly line: string }[] {
  const expected = new Map(Object.entries(TMPFS));
  const actual: { path: string; sizeBytes: string; line: string }[] = [];
  for (const line of text.trimEnd().split("\n")) {
    const fields = line.split(" "), separator = fields.indexOf("-"), path = fields[4];
    if (path === undefined) throw new Error("Kafka mountinfo line is incomplete.");
    const requested = expected.get(path);
    if (requested === undefined) continue;
    const options = new Set(fields[5]?.split(","));
    const superOptions = fields[separator + 3]?.split(",") ?? [];
    const sizes = superOptions.filter((option) => option.startsWith("size="));
    const requestedSize = /(?:^|,)size=([^,]+)/u.exec(requested)?.[1];
    if (
      separator < 6 || fields[3] !== "/" || fields[separator + 1] !== "tmpfs" ||
      !["rw", "noexec", "nosuid"].every((option) => options.has(option)) || options.has("ro") ||
      !superOptions.includes("rw") || superOptions.includes("ro") || sizes.length !== 1 ||
      requestedSize === undefined ||
      mountSize(sizes[0]!.slice(5)) !== mountSize(requestedSize) || actual.some((item) => item.path === path)
    ) {
      throw new Error("Kafka effective kernel tmpfs admission differs: " + path);
    }
    actual.push({ path, sizeBytes: mountSize(requestedSize).toString(), line });
  }
  if (actual.length !== expected.size) throw new Error("Kafka kernel namespace is missing an admitted tmpfs mount.");
  return actual;
}
function hash(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Kafka admission expected an object.");
  }
  return value as Record<string, unknown>;
}
/** Lstat before reading rejects links; the bounded second size check admits copied bytes, not just a filename. */
function file(path: string, maximum: number): Buffer<ArrayBuffer> {
  const info = lstatSync(path);
  if (!info.isFile() || info.size > maximum) throw new Error("Kafka native input exceeds regular-file admission.");
  const bytes = readFileSync(path);
  if (bytes.length !== info.size || bytes.length > maximum) {
    throw new Error("Kafka native input changed during admission.");
  }
  return bytes;
}
export interface KafkaInputType {
  /** Offline-compiled AdminMetadataOracle classes. Compilation and compiler evidence belong to the caller. */
  readonly classes: string;
  /** Directory containing the exact five admitted SDK JARs. They are copied as bytes, never installed. */
  readonly jars: string;
}
export interface KafkaCommandReceiptType {
  readonly operation: string;
  readonly stdoutBytes: number;
  readonly stdoutSha256: string;
  readonly stderr: string;
  readonly exitCode: 0;
}
/** One broker and one serial auxiliary JVM; no replication, TLS, authentication or discovery-routing claim. */
export class KafkaFixture implements AsyncDisposable {
  readonly host: string;
  readonly port: number;
  readonly topic: string;
  readonly inputs: readonly { readonly file: string; readonly bytes: number; readonly sha256: string }[];
  readonly receipts: KafkaCommandReceiptType[] = [];
  readonly #server: StartedTestContainer;
  readonly #release: () => Promise<void>;
  #closing: Promise<void> | undefined;
  #busy = false;
  #commands = 0;
  constructor(
    server: StartedTestContainer,
    topic: string,
    inputs: KafkaFixture["inputs"],
    release: () => Promise<void>,
  ) {
    this.#server = server;
    this.topic = topic;
    this.inputs = inputs;
    this.host = server.getHost();
    this.port = server.getMappedPort(9092);
    this.#release = release;
  }
  /** A timeout kills the CLI, then closes the entire owned broker so an auxiliary JVM cannot survive its deadline. */
  async #run(operation: string, command: readonly string[]): Promise<Buffer<ArrayBuffer>> {
    if (this.#closing || this.#busy || ++this.#commands > 8) {
      throw new Error("Kafka auxiliary JVM ownership or command budget exceeded.");
    }
    this.#busy = true;
    try {
      // Stderr is collected separately: Admin stdout is a binary envelope.
      const result = spawnSync("docker", ["exec", this.#server.getId(), ...command], {
        timeout: 25_000,
        maxBuffer: 2 * MIB,
        killSignal: "SIGKILL",
        stdio: ["ignore", "pipe", "pipe"],
      });
      const output = result.stdout ?? Buffer.alloc(0), stderr = result.stderr ?? Buffer.alloc(0);
      if (result.error || result.status !== 0 || result.signal || output.length > MIB || stderr.length > 65536) {
        throw new Error("Kafka native auxiliary command failed.", {
          cause: {
            operation,
            error: result.error,
            status: result.status,
            signal: result.signal,
            stdoutBytes: output.length,
            stdoutSha256: hash(output),
            // Preserve native failure envelopes for the outer receipt owner, with an explicit capture ceiling.
            stdout: Buffer.from(output.subarray(0, 2 * MIB)),
            stdoutTruncated: output.length > 2 * MIB,
            stderr: stderr.subarray(-65536).toString("utf8"),
          },
        });
      }
      this.receipts.push({
        operation,
        stdoutBytes: output.length,
        stdoutSha256: hash(output),
        stderr: stderr.toString("utf8"),
        exitCode: 0,
      });
      return output;
    } catch (reason) {
      await close([
        () => {
          execFileSync("docker", ["kill", this.#server.getId()], { timeout: 5000, maxBuffer: 65536 });
        },
        () => this.close(),
      ], [reason]);
      throw reason;
    } finally {
      this.#busy = false;
    }
  }
  /** Creates exactly one fixture-owned topic; replication factor one proves no replicated durability. */
  async init(): Promise<void> {
    await this.#run("create-topic", [
      ...environment("-Xms16m -Xmx128m"),
      "/opt/kafka/bin/kafka-topics.sh",
      "--bootstrap-server",
      "127.0.0.1:9092",
      "--create",
      "--topic",
      this.topic,
      "--partitions",
      "1",
      "--replication-factor",
      "1",
    ]);
  }
  /** Returns the native AMO1 envelope; the caller separately decodes and compares full semantic observations. */
  admin(): Promise<Buffer<ArrayBuffer>> {
    const jars = JARS.map(([name]) => "/oracle/" + name).join(":");
    return this.#run("admin-metadata", [
      ...environment("-Xms16m -Xmx128m"),
      "/opt/java/openjdk/bin/java",
      "-Xms16m",
      "-Xmx128m",
      "-XX:ActiveProcessorCount=1",
      "-cp",
      `/oracle:${jars}`,
      "AdminMetadataOracle",
      "127.0.0.1:9092",
      this.topic,
      "0",
    ]);
  }
  close(): Promise<void> {
    return this.#closing ??= this.#release();
  }
  [Symbol.asyncDispose](): Promise<void> {
    return this.close();
  }
}
/** Starts the native fixture only when called; offline compilation remains the caller's responsibility. */
export async function openKafka(options: KafkaInputType): Promise<KafkaFixture> {
  const { GenericContainer, Network, Wait, getContainerRuntimeClient } = await import("testcontainers");
  const copies: { content: Buffer<ArrayBuffer>; target: string; mode: number }[] = [];
  const inputs: { file: string; bytes: number; sha256: string }[] = [];
  function admit(name: string, bytes: Buffer<ArrayBuffer>): void {
    copies.push({ content: bytes, target: "/oracle/" + name, mode: 0o444 });
    inputs.push({ file: name, bytes: bytes.length, sha256: hash(bytes) });
  }
  for (const [name, bytes, sha] of JARS) {
    const value = file(join(resolve(options.jars), name), bytes);
    if (value.length !== bytes || hash(value) !== sha) throw new Error("Kafka SDK input identity differs.");
    admit(name, value);
  }
  const names = readdirSync(resolve(options.classes)).filter((name) =>
    /^AdminMetadataOracle(?:\$[A-Za-z0-9_]+)?\.class$/u.test(name)
  ).sort();
  if (!names.includes("AdminMetadataOracle.class") || names.length > 16) {
    throw new Error("Kafka Admin class set differs.");
  }
  let classBytes = 0;
  for (const name of names) {
    const value = file(join(resolve(options.classes), name), 65536);
    classBytes += value.length;
    if (classBytes > MIB || value.length < 4 || value.readUInt32BE(0) !== 0xcafebabe) {
      throw new Error("Kafka compiled class admission differs.");
    }
    admit(name, value);
  }
  const runtime = await getContainerRuntimeClient(), releases: (() => Promise<unknown>)[] = [];
  const label = "kafka-metadata-" + randomUUID(), topic = "opfs-metadata-" + randomUUID();
  let networkName: string | undefined, id: string | undefined;
  let releasing: Promise<void> | undefined;
  const release = (): Promise<void> => releasing ??= close([...releases].reverse());
  /** Inspect is bounded and used before start and again after readiness; no target service is contacted. */
  function inspect(container: string, created: boolean): void {
    const value = record(
      JSON.parse(
        execFileSync("docker", [
          "inspect",
          "--format",
          '{"host":{{json .HostConfig}},"state":{{json .State}},"mounts":{{json .Mounts}},"config":{{json .Config}},"image":{{json .Image}}}',
          container,
        ], { timeout: 10000, maxBuffer: 131072, encoding: "utf8" }),
      ),
    );
    const host = record(value.host),
      state = record(value.state),
      config = record(value.config),
      tmpfs = record(host.Tmpfs);
    const imageList: unknown = JSON.parse(
      execFileSync("docker", ["image", "inspect", KAFKA_IMAGE], {
        timeout: 10000,
        maxBuffer: 131072,
        encoding: "utf8",
      }),
    );
    if (!Array.isArray(imageList) || imageList.length !== 1) throw new Error("Kafka image inspection differs.");
    const image = record(imageList[0]);
    if (
      image.Id !== value.image || image.Os !== "linux" || !Array.isArray(image.RepoDigests) ||
      !image.RepoDigests.includes(KAFKA_IMAGE)
    ) throw new Error("Kafka immutable image admission differs.");
    const bindings = record(host.PortBindings);
    if (
      state.OOMKilled || created && (state.Status !== "created" || state.Running) ||
      !created && state.Running !== true || config.Image !== KAFKA_IMAGE ||
      host.Memory !== 1073741824 || host.MemorySwap !== 1073741824 || host.NanoCpus !== 1000000000 ||
      host.PidsLimit !== 128 || host.Privileged || host.NetworkMode !== networkName ||
      host.IpcMode === "host" || Array.isArray(host.Devices) && host.Devices.length > 0 ||
      Array.isArray(host.DeviceRequests) && host.DeviceRequests.length > 0 ||
      Array.isArray(host.ExtraHosts) && host.ExtraHosts.length > 0 ||
      host.Binds !== null && (!Array.isArray(host.Binds) || host.Binds.length) ||
      host.CapAdd !== null && (!Array.isArray(host.CapAdd) || host.CapAdd.length) || host.PublishAllPorts ||
      Object.keys(bindings).join() !== "9092/tcp" || Object.keys(tmpfs).length !== Object.keys(TMPFS).length
    ) throw new Error("Kafka native resource or isolation admission differs.");
    for (const [key, extent] of Object.entries(TMPFS)) {
      if (tmpfs[key] !== extent) throw new Error("Kafka native tmpfs extent differs.");
    }
    const published = bindings["9092/tcp"];
    if (!Array.isArray(published) || published.length !== 1 || created && record(published[0]).HostPort !== "0") {
      throw new Error("Kafka native host-port mapping differs.");
    }
    if (
      !Array.isArray(value.mounts) ||
      value.mounts.some((mount) => {
        const item = record(mount);
        return item.Type !== "tmpfs" || typeof item.Destination !== "string" || !Object.hasOwn(TMPFS, item.Destination);
      })
    ) throw new Error("Kafka native mounts differ.");
    if (!created) {
      // Engine Mounts may omit tmpfs. The kernel namespace independently proves each effective mounted ceiling.
      const mountinfo = execFileSync("docker", ["exec", container, "/bin/cat", "/proc/self/mountinfo"], {
        timeout: 10000,
        maxBuffer: 131072,
        encoding: "utf8",
      });
      const actual = kernelMounts(mountinfo);
      console.log(
        JSON.stringify({
          phase: "kafka-kernel-mounts",
          id: container,
          mountinfoSha256: hash(Buffer.from(mountinfo)),
          actual,
        }),
      );
    }
    console.log(JSON.stringify({ phase: created ? "kafka-prestart" : "kafka-ready", id: container, ...value }));
  }
  async function diagnostics(container: string): Promise<void> {
    const failures: unknown[] = [];
    for (const command of [["inspect", container], ["logs", "--tail", "120", container]]) {
      try {
        console.log(execFileSync("docker", command, { timeout: 10000, maxBuffer: 262144, encoding: "utf8" }));
      } catch (reason) {
        failures.push(reason);
      }
    }
    if (failures.length) throw new AggregateError(failures, "Kafka owned diagnostics failed.");
  }
  const registered = new Set<string>();
  /** Register before any later admission can fail; only exact fixture-owned IDs enter this ledger. */
  function registerRemoval(value: string): void {
    if (registered.has(value)) return;
    registered.add(value);
    releases.push(async () => {
      const owned = runtime.container.getById(value);
      try {
        await owned.remove({ force: true, v: true });
      } catch (reason) {
        if (reason === null || typeof reason !== "object" || !("statusCode" in reason) || reason.statusCode !== 404) {
          throw reason;
        }
      }
    });
  }
  /** Copies precede containerCreated in Testcontainers. Recover that narrow failure seam by exact random label and image. */
  function recoverConstruction(): void {
    if (releasing) return;
    const output = execFileSync("docker", [
      "ps",
      "--all",
      "--no-trunc",
      "--filter",
      "label=opfs.fixture=" + label,
      "--filter",
      "ancestor=" + KAFKA_IMAGE,
      "--format",
      "{{.ID}}",
    ], { timeout: 10000, maxBuffer: 4096, encoding: "utf8" });
    const found = output.trim().length === 0 ? [] : output.trim().split(/\r?\n/u);
    if (
      found.length > 4 || new Set(found).size !== found.length || found.some((value) => !/^[0-9a-f]{64}$/u.test(value))
    ) throw new Error("Kafka owned-container recovery exceeded its exact-ID admission.");
    for (const value of found) {
      const detail = record(
        JSON.parse(
          execFileSync("docker", ["inspect", "--format", '{"id":{{json .Id}},"config":{{json .Config}}}', value], {
            timeout: 10000,
            maxBuffer: 131072,
            encoding: "utf8",
          }),
        ),
      );
      const config = record(detail.config), labels = record(config.Labels);
      if (detail.id !== value || config.Image !== KAFKA_IMAGE || labels["opfs.fixture"] !== label) {
        throw new Error("Kafka partial-construction ownership differs; refusing removal.");
      }
      registerRemoval(value);
      id = value;
    }
  }
  class OwnedContainer extends GenericContainer {
    constructor() {
      super(KAFKA_IMAGE);
      this.hostConfig.MemorySwap = 1073741824;
      this.hostConfig.PidsLimit = 128;
      this.hostConfig.LogConfig = { Type: "json-file", Config: { "max-size": "1m", "max-file": "1" } };
    }
    protected override containerCreated(value: string): Promise<void> {
      id = value;
      registerRemoval(value);
      inspect(value, true);
      return Promise.resolve();
    }
  }
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
          await close([() => diagnostics(container.id)], [reason]);
          throw reason;
        }
      },
    };
  }
  try {
    const network = await new Network().start();
    networkName = network.getName();
    releases.push(() => network.stop());
    const format = [
      ...environment("-Xms16m -Xmx128m"),
      "/opt/kafka/bin/kafka-storage.sh",
      "format",
      "--cluster-id",
      randomBytes(16).toString("base64url"),
      "--config",
      "/fixture/server.properties",
    ];
    const broker = [
      ...environment("-Xms64m -Xmx256m"),
      "/opt/kafka/bin/kafka-server-start.sh",
      "/fixture/server.properties",
    ];
    // All tokens are fixed authored values or base64url-only cluster identity. No user shell fragments enter startup.
    const shell = format.map((word) => "'" + word + "'").join(" ") + " && exec " +
      broker.map((word) => "'" + word + "'").join(" ");
    const server = await new OwnedContainer().withNetwork(network).withLabels({ "opfs.fixture": label }).withTmpFs(
      TMPFS,
    ).withCopyContentToContainer([
      ...copies,
      { content: CONFIG, target: "/fixture/server.properties", mode: 0o444 },
      { content: LOGGING, target: "/fixture/log4j2.properties", mode: 0o444 },
    ]).withEntrypoint(["/bin/sh"]).withCommand(["-c", shell]).withExposedPorts(9092).withResourcesQuota({
      memory: 1,
      cpu: 1,
    }).withWaitStrategy(diagnose(Wait.forLogMessage("Kafka Server started"))).withStartupTimeout(60_000).start();
    releases.push(() => server.stop());
    inspect(server.getId(), false);
    const fixture = new KafkaFixture(
      server,
      topic,
      inputs,
      () => close([() => diagnostics(server.getId()), release]),
    );
    await fixture.init();
    return fixture;
  } catch (reason) {
    await close([
      recoverConstruction,
      async () => {
        if (id && !releasing) await diagnostics(id);
      },
      release,
    ], [reason]);
    throw reason;
  }
}
