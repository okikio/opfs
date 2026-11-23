import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { createConnection } from "node:net";
import type { Socket } from "node:net";
import { close } from "../../src/close.ts";
import type { NatsChannelType } from "../../src/nats.ts";
import type { StartedTestContainer } from "testcontainers";

export const NATS_IMAGE = "nats:2.15.2@sha256:991242c32d2738ffd358fd6614dd96c735017b4b3b34bfdb2c52a072d66db211";
/** Await destruction of only fixture-owned sockets under a finite close deadline. */
function retire(socket: Socket): Promise<void> {
  if (socket.closed) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const ended = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      socket.off("close", ended);
      reject(new Error("Owned NATS fixture socket close deadline."));
    }, 5000);
    socket.once("close", ended);
    socket.destroy();
  });
}
/** Test-only socket transport bounds chunks without changing any native command/reply bytes. It makes no TLS proof. */
function wrap(socket: Socket, retired: () => void): NatsChannelType {
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
            } else if (socket.destroyed) error(new Error("Owned NATS fixture socket closed."));
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
/** Disposable single-node JetStream server and independent SDK; no caller service or credentials are used. */
export class NatsFixture implements AsyncDisposable {
  readonly auth = { user: "opfs", password: "fixture-only-nats" };
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
  async openChannel({ signal }: { readonly signal: AbortSignal }): Promise<NatsChannelType> {
    signal.throwIfAborted();
    const socket = createConnection({ host: this.#server.getHost(), port: this.#server.getMappedPort(4222) });
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
  async #run(operation: "init" | "seed" | "read" | "other", sequence?: string): Promise<Record<string, unknown>> {
    const command = ["timeout", "20", "/oracle/oracle", operation];
    if (sequence !== undefined) command.push(sequence);
    const result = await this.#oracle.exec(command);
    if (result.exitCode !== 0 || result.output.length > 2 * 1048576) {
      throw new Error("Independent NATS SDK operation failed.", { cause: result.output.slice(0, 65536) });
    }
    const lines = result.output.split(/\r?\n/u).filter((line) => line.startsWith("RECEIPT:"));
    if (lines.length !== 1) throw new Error("Independent NATS receipt is missing or duplicated.");
    const value: unknown = JSON.parse(lines[0]!.slice(8));
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("Invalid NATS oracle receipt.");
    }
    return value as Record<string, unknown>;
  }
  async init(): Promise<void> {
    const result = await this.#server.exec(["/nats-server", "--version"]);
    if (result.exitCode !== 0 || result.output.length > 8192 || !result.output.includes("v2.15.2")) {
      throw new Error("Wrong native NATS version.");
    }
    const build = await this.#oracle.exec([
      "sh",
      "-c",
      "cat /oracle/receipts/packages.txt /oracle/receipts/debs.sha256 /oracle/receipts/artifacts.sha256 /oracle/receipts/compiler.txt",
    ]);
    if (build.exitCode !== 0 || build.output.length > 1048576) {
      throw new Error("Native NATS build receipt ceiling/failure.");
    }
    console.log(
      JSON.stringify({
        nativeVersion: result.output.trim(),
        nativeBuildReceipts: build.output,
        oracle: await this.#run("init"),
      }),
    );
  }
  async seed(bytes: Uint8Array): Promise<string> {
    if (bytes.length > 1048576) throw new Error("Independent NATS seed exceeds policy.");
    await this.#oracle.copyContentToContainer([{ content: Buffer.from(bytes), target: "/oracle/value.bin" }]);
    const value = await this.#run("seed");
    if (value.stream !== "OWNED" || typeof value.sequence !== "string" || !/^[1-9][0-9]{0,19}$/.test(value.sequence)) {
      throw new Error("Invalid independent NATS publish acknowledgement.");
    }
    return value.sequence;
  }
  async read(sequence: string): Promise<Uint8Array<ArrayBuffer>> {
    if (!/^[1-9][0-9]{0,19}$/.test(sequence)) throw new Error("Independent NATS sequence exceeds policy.");
    const value = await this.#run("read", sequence);
    if (
      value.sequence !== sequence || value.subject !== "owned.data" || typeof value.base64 !== "string" ||
      value.base64.length > 1398104
    ) throw new Error("Independent NATS read identity differs.");
    return new Uint8Array(Buffer.from(value.base64, "base64"));
  }
  async otherCount(): Promise<string> {
    const value = await this.#run("other");
    if (typeof value.messages !== "string") throw new Error("Invalid independent other-stream receipt.");
    return value.messages;
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
/** Build the test-only native SDK oracle through Testcontainers, then run it on the disposable private network. */
export async function openNats(): Promise<NatsFixture> {
  const { GenericContainer, Network, Wait, getContainerRuntimeClient } = await import("testcontainers");
  const runtime = await getContainerRuntimeClient(), resources: (() => Promise<unknown>)[] = [], ids: string[] = [];
  class OwnedContainer extends GenericContainer {
    readonly #server: boolean;
    constructor(image: string) {
      super(image);
      this.#server = image === NATS_IMAGE;
      this.hostConfig.PidsLimit = 128;
      this.hostConfig.MemorySwap = 268435456;
      this.withLabels({ "opfs.fixture": "nats-native-20261105-implement-gcs" });
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
      // containerCreated runs before engine start. Admission here prevents
      // server/SDK execution under a silently changed requested resource policy.
      const raw = execFileSync("docker", [
        "inspect",
        "--format",
        '{"host":{{json .HostConfig}},"mounts":{{json .Mounts}},"state":{{json .State}}}',
        id,
      ], { encoding: "utf8", timeout: 10000, maxBuffer: 131072 });
      const value = JSON.parse(raw);
      if (
        value.state.Status !== "created" || value.state.Running || value.host.Memory !== 268435456 ||
        value.host.MemorySwap !== 268435456 || value.host.NanoCpus !== 500000000 || value.host.PidsLimit !== 128 ||
        value.host.Binds?.length || !Array.isArray(value.mounts) ||
        value.mounts.some((mount: { Type: string; Destination: string }) =>
          mount.Type !== "tmpfs" || mount.Destination !== "/data"
        ) ||
        !this.#server && value.mounts.length !== 0 ||
        this.#server && value.host.Tmpfs?.["/data"] !== "rw,noexec,nosuid,size=16m,mode=0777"
      ) {
        throw new Error("Native NATS pre-start resource admission differs.");
      }
      console.log(JSON.stringify({ fixturePrestartResource: id, ...value }));
      return Promise.resolve();
    }
  }
  try {
    const oracleImage = `opfs-nats-oracle-${randomUUID()}`;
    await GenericContainer.fromDockerfile(fileURLToPath(new URL("../fixtures/nats/", import.meta.url).href)).build(
      oracleImage,
    );
    const network = await new Network().start();
    resources.push(() => network.stop());
    const server = await new OwnedContainer(NATS_IMAGE).withNetwork(network).withNetworkAliases("nats.test")
      .withCopyContentToContainer([{
        target: "/fixture.conf",
        content: `port: 4222
max_payload: 2097152
jetstream { store_dir: "/data", max_memory_store: 8MB, max_file_store: 8MB }
authorization { users: [
 {user: "oracle", password: "fixture-only-oracle"},
 {user: "opfs", password: "fixture-only-nats", permissions: {publish: ["owned.data", "other.data", "$JS.API.STREAM.MSG.GET.OWNED"], subscribe: ["_INBOX.>"]}}
] }
`,
      }]).withTmpFs({ "/data": "rw,noexec,nosuid,size=16m,mode=0777" })
      .withEntrypoint(["/nats-server"]).withCommand(["--config", "/fixture.conf"]).withExposedPorts(4222)
      .withResourcesQuota({ memory: 0.25, cpu: 0.5 }).withWaitStrategy(Wait.forLogMessage("Server is ready"))
      .withStartupTimeout(45_000).start();
    resources.push(() => server.stop());
    const oracle = await new OwnedContainer(oracleImage).withNetwork(network)
      .withResourcesQuota({ memory: 0.25, cpu: 0.5 }).withWaitStrategy(
        Wait.forSuccessfulCommand("test -x /oracle/oracle"),
      ).withStartupTimeout(60_000).start();
    resources.push(() => oracle.stop());
    for (const container of [server, oracle]) {
      const raw = execFileSync("docker", [
        "inspect",
        "--format",
        '{"host":{{json .HostConfig}},"mounts":{{json .Mounts}}}',
        container.getId(),
      ], { encoding: "utf8", timeout: 10000, maxBuffer: 131072 });
      const value = JSON.parse(raw);
      if (
        value.host.Memory !== 268435456 || value.host.MemorySwap !== 268435456 || value.host.NanoCpus !== 500000000 ||
        value.host.PidsLimit !== 128 || !Array.isArray(value.mounts) ||
        value.mounts.some((mount: { Type: string; Destination: string }) =>
          mount.Type !== "tmpfs" || mount.Destination !== "/data"
        ) ||
        container === oracle && value.mounts.length !== 0 ||
        container === server && value.host.Tmpfs?.["/data"] !== "rw,noexec,nosuid,size=16m,mode=0777"
      ) throw new Error("Actual native NATS fixture resources differ.");
      console.log(JSON.stringify({ fixtureResource: container.getId(), ...value }));
    }
    const fixture = new NatsFixture(server, oracle, resources);
    await fixture.init();
    return fixture;
  } catch (reason) {
    for (const id of ids) {
      try {
        console.error(
          "NATS fixture bootstrap:",
          id,
          execFileSync("docker", ["logs", id], { encoding: "utf8", timeout: 10000, maxBuffer: 1048576 }),
        );
      } catch (failure) {
        console.error("NATS fixture diagnostics unavailable:", id, failure);
      }
    }
    await close(resources.reverse(), [reason]);
    throw reason;
  }
}
