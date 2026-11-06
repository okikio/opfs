import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { createConnection } from "node:net";
import type { Socket } from "node:net";
import { close } from "../../src/close.ts";
import type { RedisChannelType } from "../../src/redis.ts";
import type { StartedTestContainer } from "testcontainers";

const PASSWORD = "fixture-only-redis";

export const REDIS_IMAGE = "redis:8.10.3@sha256:f245f4c83b84a9e9a0588da1c9456e579455310f0945d5db52cd2ba27f2000cc";
export const VALKEY_IMAGE =
  "valkey/valkey:9.1.3@sha256:3add1a336a920ea54770a001ab6feb3da5fceea96a40373a3a2cd469b815f0b7";
function retire(socket: Socket): Promise<void> {
  if (socket.closed) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const ended = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      socket.off("close", ended);
      reject(new Error("Owned Redis fixture socket close deadline."));
    }, 5000);
    socket.once("close", ended);
    socket.destroy();
  });
}
/** Test-only socket transport bounds chunks without changing any native command/reply bytes. It makes no TLS proof. */
function wrap(socket: Socket, retired: () => void): RedisChannelType {
  let closing: Promise<void> | undefined;
  return {
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
            } else if (socket.destroyed) error(new Error("Owned Redis fixture socket closed."));
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
/** Disposable single-node database and independent SDK. No caller endpoint, database or credentials are borrowed. */
export class RedisFixture implements AsyncDisposable {
  readonly auth = { username: new TextEncoder().encode("opfs"), password: new TextEncoder().encode(PASSWORD) };
  readonly #server: StartedTestContainer;
  readonly #oracle: StartedTestContainer;
  readonly #resources: readonly (() => Promise<unknown>)[];
  readonly #sockets = new Set<Socket>();
  #closing: Promise<void> | undefined;
  constructor(
    server: StartedTestContainer,
    oracle: StartedTestContainer,
    resources: readonly (() => Promise<unknown>)[],
  ) {
    this.#server = server;
    this.#oracle = oracle;
    this.#resources = [...resources];
  }
  async openChannel({ signal }: { readonly signal: AbortSignal }): Promise<RedisChannelType> {
    signal.throwIfAborted();
    const socket = createConnection({ host: this.#server.getHost(), port: this.#server.getMappedPort(6379) });
    socket.on("error", () => {});
    this.#sockets.add(socket);
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
      return wrap(socket, () => this.#sockets.delete(socket));
    } catch (reason) {
      this.#sockets.delete(socket);
      await close([() => retire(socket)], [reason]);
      throw reason;
    }
  }
  async #run(operation: "init" | "seed" | "read"): Promise<Record<string, unknown>> {
    const result = await this.#oracle.exec(["timeout", "--signal=KILL", "20", "/oracle/oracle", operation]);
    if (result.exitCode !== 0 || result.output.length > 2 * 1048576) {
      throw new Error("Independent hiredis operation failed.", { cause: result.output.slice(0, 65536) });
    }
    const lines = result.output.split(/\r?\n/u).filter((line) => line.startsWith("RECEIPT:"));
    if (lines.length !== 1) throw new Error("Independent hiredis receipt is missing or duplicated.");
    const value: unknown = JSON.parse(lines[0]!.slice(8));
    if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid oracle receipt.");
    return value as Record<string, unknown>;
  }
  async init(kind: "redis" | "valkey"): Promise<void> {
    const version = await this.#server.exec([kind + "-server", "--version"]);
    const expected = kind === "redis" ? "8.10.3" : "9.1.3";
    if (version.exitCode !== 0 || version.output.length > 8192 || !version.output.includes("v=" + expected)) {
      throw new Error("Wrong native Redis/Valkey server version.");
    }
    console.log(JSON.stringify({ kind, version: version.output.trim(), oracle: await this.#run("init") }));
  }
  async seed(key: Uint8Array, bytes: Uint8Array): Promise<void> {
    if (key.length > 1024 || bytes.length > 1048576) throw new Error("Independent Redis fixture input exceeds policy.");
    await this.#oracle.copyContentToContainer([
      { content: Buffer.from(key), target: "/oracle/key.bin", mode: 0o644 },
      { content: Buffer.from(bytes), target: "/oracle/value.bin", mode: 0o644 },
    ]);
    if ((await this.#run("seed")).stored !== true) throw new Error("Independent Redis seed lacks acknowledgement.");
  }
  /** A second native producer uses the server's bundled CLI with stdin, never a shell or base64 argv payload. */
  seedCli(kind: "redis" | "valkey", bytes: Uint8Array): void {
    if (bytes.length > 1048576) throw new Error("Native Redis CLI input exceeds policy.");
    const output = execFileSync("docker", [
      "exec",
      "-i",
      this.#server.getId(),
      kind + "-cli",
      "--user",
      "opfs",
      "--pass",
      PASSWORD,
      "-n",
      "3",
      "-x",
      "SET",
      "cli-owned-key",
    ], { input: Buffer.from(bytes), encoding: "utf8", timeout: 10_000, killSignal: "SIGKILL", maxBuffer: 65536 });
    if (output.trim() !== "OK") throw new Error("Native Redis CLI seed lacks acknowledgement.");
  }
  async read(key: Uint8Array): Promise<{ readonly bytes: Uint8Array<ArrayBuffer> | null; readonly ttl: string }> {
    if (key.length > 1024) throw new Error("Independent Redis fixture key exceeds policy.");
    await this.#oracle.copyContentToContainer([{ content: Buffer.from(key), target: "/oracle/key.bin", mode: 0o644 }]);
    const value = await this.#run("read");
    if (
      typeof value.missing !== "boolean" || typeof value.ttl !== "string" || value.ttl.length > 20 ||
      !/^(?:-2|-1|0|[1-9][0-9]*)$/u.test(value.ttl) || BigInt(value.ttl) > 9223372036854775807n
    ) throw new Error("Invalid oracle state.");
    if (value.missing) {
      if (value.base64 !== null) throw new Error("Missing independent Redis key has bytes.");
      return { bytes: null, ttl: value.ttl };
    }
    if (typeof value.base64 !== "string" || value.base64.length > 1398104) throw new Error("Invalid oracle bytes.");
    const bytes = Buffer.from(value.base64, "base64");
    if (bytes.length > 1048576 || bytes.toString("base64") !== value.base64) {
      throw new Error("Independent Redis bytes are not canonical bounded base64.");
    }
    return { bytes: new Uint8Array(bytes), ttl: value.ttl };
  }
  close(): Promise<void> {
    return this.#closing ??= close([async () => {
      await close([...this.#sockets].map((socket) => () => retire(socket)));
      this.#sockets.clear();
    }, ...[...this.#resources].reverse()]);
  }
  [Symbol.asyncDispose](): Promise<void> {
    return this.close();
  }
}
/** Separate recipe/acquisition approval is required. Each call owns one native server, one native client container and a private network. */
export async function openRedis(kind: "redis" | "valkey"): Promise<RedisFixture> {
  const { GenericContainer, Network, Wait, getContainerRuntimeClient } = await import("testcontainers");
  const runtime = await getContainerRuntimeClient(), resources: (() => Promise<unknown>)[] = [], ids: string[] = [];
  class OwnedContainer extends GenericContainer {
    constructor(image: string) {
      super(image);
      this.hostConfig.PidsLimit = 128;
      this.hostConfig.MemorySwap = 268435456;
      this.withLabels({ "opfs.fixture": "redis-native-20261105-implement-gcs" });
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
    const oracleImage = `opfs-redis-oracle-${randomUUID()}`;
    await GenericContainer.fromDockerfile(fileURLToPath(new URL("../fixtures/redis/", import.meta.url).href)).build(
      oracleImage,
    );
    const network = await new Network().start();
    resources.push(() => network.stop());
    const server = await new OwnedContainer(kind === "redis" ? REDIS_IMAGE : VALKEY_IMAGE).withNetwork(network)
      .withNetworkAliases("redis.test").withCopyContentToContainer([{
        content:
          `user default off\nuser opfs on >${PASSWORD} ~* +get +set +pttl +del +select +ping +info +client|setinfo\n`,
        target: "/tmp/opfs.acl",
      }]).withTmpFs({ "/data": "rw,noexec,nosuid,size=16m,mode=0777" }).withCommand([
        kind + "-server",
        "--bind",
        "0.0.0.0",
        "--port",
        "6379",
        "--protected-mode",
        "yes",
        "--save",
        "",
        "--appendonly",
        "no",
        "--maxmemory",
        "32mb",
        "--maxmemory-policy",
        "noeviction",
        "--aclfile",
        "/tmp/opfs.acl",
        "--dir",
        "/data",
      ]).withExposedPorts(6379).withResourcesQuota({ memory: 0.25, cpu: 0.5 })
      .withWaitStrategy(Wait.forSuccessfulCommand(`${kind}-cli --user opfs --pass ${PASSWORD} PING`))
      .withStartupTimeout(45_000).start();
    resources.push(() => server.stop());
    const oracle = await new OwnedContainer(oracleImage).withNetwork(network)
      .withResourcesQuota({ memory: 0.25, cpu: 0.5 })
      .withWaitStrategy(Wait.forSuccessfulCommand("test -x /oracle/oracle")).withStartupTimeout(60_000).start();
    resources.push(() => oracle.stop());
    for (const container of [server, oracle]) {
      const raw = execFileSync("docker", [
        "inspect",
        "--format",
        '{"host":{{json .HostConfig}},"mounts":{{json .Mounts}}}',
        container.getId(),
      ], {
        encoding: "utf8",
        timeout: 10_000,
        maxBuffer: 131072,
      });
      const value = JSON.parse(raw);
      if (
        value.host.Memory !== 268435456 || value.host.MemorySwap !== 268435456 || value.host.NanoCpus !== 500000000 ||
        value.host.PidsLimit !== 128 || !Array.isArray(value.mounts) ||
        value.mounts.some((mount: { Type: string; Destination: string }) =>
          mount.Type !== "tmpfs" || mount.Destination !== "/data"
        ) ||
        container === oracle && value.mounts.length !== 0 ||
        container === server && value.host.Tmpfs?.["/data"] !== "rw,noexec,nosuid,size=16m,mode=0777"
      ) throw new Error("Actual native Redis fixture resource policy differs.");
      console.log(JSON.stringify({ fixtureResource: container.getId(), ...value }));
    }
    const fixture = new RedisFixture(server, oracle, resources);
    await fixture.init(kind);
    return fixture;
  } catch (reason) {
    for (const id of ids) {
      try {
        console.error(
          "Redis fixture bootstrap:",
          id,
          execFileSync("docker", ["logs", id], {
            encoding: "utf8",
            timeout: 10_000,
            maxBuffer: 1048576,
          }),
        );
      } catch (failure) {
        console.error("Redis fixture diagnostics unavailable:", id, failure);
      }
    }
    await close(resources.reverse(), [reason]);
    throw reason;
  }
}
