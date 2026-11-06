import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { createConnection } from "node:net";
import type { Socket } from "node:net";
import { execFileSync } from "node:child_process";
import { close } from "../../src/close.ts";
import type { MemcachedChannelType } from "../../src/memcached.ts";
import type { StartedTestContainer } from "testcontainers";

export const MEMCACHED_IMAGE =
  "memcached:1.6.45-alpine@sha256:6a089e37cbb8acd75c80c6c0667fe57ec54db68782fb1b3afb1d0eb265e50070";
/** Socket destruction is awaited, with a finite fixture-only close deadline and no remote graceful-close dependency. */
function retire(socket: Socket): Promise<void> {
  if (socket.closed) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const ended = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      socket.off("close", ended);
      reject(new Error("Owned fixture socket close deadline."));
    }, 5000);
    socket.once("close", ended);
    socket.destroy();
  });
}
/** Node's native socket adapter is test-only. Its chunk splitting changes transport delivery, never command bytes or replies. */
function wrap(socket: Socket, retired: () => void): MemcachedChannelType {
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
            } else if (socket.destroyed) error(new Error("Owned Memcached fixture socket closed."));
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
function field(output: string, prefix: string): string {
  const rows = output.split(/\r?\n/u).filter((row) => row.startsWith(prefix + ":"));
  if (rows.length !== 1) throw new Error("Independent Memcached receipt is missing or duplicated.");
  return rows[0]!.slice(prefix.length + 1);
}
/** Only disposable private-network resources and sockets are owned; no host cache, credential or configuration is borrowed. */
export class MemcachedFixture implements AsyncDisposable {
  readonly #server: StartedTestContainer;
  readonly #oracle: StartedTestContainer;
  readonly #resources: readonly (() => Promise<unknown>)[];
  readonly #sockets = new Set<Socket>();
  #closure: Promise<void> | undefined;
  constructor(
    server: StartedTestContainer,
    oracle: StartedTestContainer,
    resources: readonly (() => Promise<unknown>)[],
  ) {
    this.#server = server;
    this.#oracle = oracle;
    this.#resources = [...resources];
  }
  /** Acquired channels are transferred to the candidate; the fixture retains only an emergency teardown of unclosed sockets. */
  async openChannel({ signal }: { readonly signal: AbortSignal }): Promise<MemcachedChannelType> {
    signal.throwIfAborted();
    const socket = createConnection({ host: this.#server.getHost(), port: this.#server.getMappedPort(11211) });
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
      if (signal.aborted) {
        socket.destroy();
        throw signal.reason;
      }
      return wrap(socket, () => this.#sockets.delete(socket));
    } catch (reason) {
      this.#sockets.delete(socket);
      await close([() => retire(socket)], [reason]);
      throw reason;
    }
  }
  async #command(args: string[]): Promise<string> {
    const result = await this.#oracle.exec(["timeout", "20", "/oracle/oracle", ...args]);
    if (result.exitCode !== 0 || result.output.length > 2 * 1048576) {
      const diagnostic = result.output.replace(/^BYTES:[^\r\n]*/mu, "BYTES:[payload elided]");
      throw new Error(
        `Independent libmemcached failed (exit ${result.exitCode}, ${result.output.length} output characters): ${
          diagnostic.slice(0, 2048)
        }\nTail: ${diagnostic.slice(-1024)}`,
      );
    }
    return result.output;
  }
  async init(): Promise<void> {
    if (field(await this.#command(["init"]), "VERSION") !== "1.6.45") {
      throw new Error("Wrong native Memcached version.");
    }
  }
  async seed(key: string, bytes: Uint8Array): Promise<void> {
    if (!/^[\u0021-\u007e]{1,250}$/u.test(key) || bytes.length > 1048576) {
      throw new Error("Memcached fixture input policy.");
    }
    await this.#oracle.copyContentToContainer([{ content: Buffer.from(bytes), target: "/oracle/input.bin" }]);
    if (field(await this.#command(["seed", key]), "STORED") !== "true") {
      throw new Error("Independent seed lacks acknowledgement.");
    }
  }
  async read(key: string): Promise<{ readonly bytes: Uint8Array<ArrayBuffer>; readonly cas: string } | null> {
    const output = await this.#command(["read", key]);
    if (output.includes("MISSING:true")) return null;
    return { bytes: new Uint8Array(Buffer.from(field(output, "BYTES"), "base64")), cas: field(output, "CAS") };
  }
  close(): Promise<void> {
    return this.#closure ??= close([async () => {
      await close([...this.#sockets].map((socket) => () => retire(socket)));
      this.#sockets.clear();
    }, ...[...this.#resources].reverse()]);
  }
  [Symbol.asyncDispose](): Promise<void> {
    return this.close();
  }
}
/** Testcontainers owns a private server and independent native libmemcached client; acquisition receipts remain separate from test results. */
export async function openMemcached(): Promise<MemcachedFixture> {
  const { GenericContainer, Network, Wait, getContainerRuntimeClient } = await import("testcontainers");
  const runtime = await getContainerRuntimeClient();
  const resources: (() => Promise<unknown>)[] = [], ids: string[] = [];
  class OwnedContainer extends GenericContainer {
    constructor(image: string) {
      super(image);
      this.hostConfig.PidsLimit = 128;
    }
    protected override containerCreated(id: string): Promise<void> {
      ids.push(id);
      // Register immediately, before startup can fail. Normal stop removes it first; only a confirmed 404 means already gone.
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
    const oracleImage = `opfs-memcached-oracle-${randomUUID()}`;
    await GenericContainer.fromDockerfile(fileURLToPath(new URL("../fixtures/memcached/", import.meta.url).href)).build(
      oracleImage,
    );
    const network = await new Network().start();
    resources.push(() => network.stop());
    const server = await new OwnedContainer(MEMCACHED_IMAGE).withNetwork(network).withNetworkAliases("memcached.test")
      .withCommand(["memcached", "-m", "16", "-I", "1m", "-U", "0", "-t", "1"])
      .withExposedPorts(11211).withResourcesQuota({ memory: 0.125, cpu: 0.5 }).withWaitStrategy(
        Wait.forListeningPorts(),
      ).withStartupTimeout(45_000).start();
    resources.push(() => server.stop());
    const oracle = await new OwnedContainer(oracleImage).withNetwork(network)
      .withCommand(["sleep", "600"])
      .withResourcesQuota({ memory: 0.5, cpu: 0.5 }).withWaitStrategy(
        Wait.forSuccessfulCommand("test -x /oracle/oracle"),
      ).withStartupTimeout(60_000).start();
    resources.push(() => oracle.stop());
    // Docker's actual host-config readback qualifies resource limits independently of fluent recipe calls.
    for (const [container, memory] of [[server, 134217728], [oracle, 536870912]] as const) {
      const raw = execFileSync("docker", ["inspect", "--format", "{{json .HostConfig}}", container.getId()], {
        encoding: "utf8",
        timeout: 10_000,
        maxBuffer: 65536,
      });
      const config: unknown = JSON.parse(raw);
      if (
        config === null || typeof config !== "object" || !("Memory" in config) || config.Memory !== memory ||
        !("NanoCpus" in config) || config.NanoCpus !== 500000000 || !("PidsLimit" in config) || config.PidsLimit !== 128
      ) throw new Error("Actual native fixture quota differs from its recipe.");
      console.log(
        JSON.stringify({
          fixtureResource: container.getId(),
          memoryBytes: memory,
          nanoCpus: 500000000,
          pidsLimit: 128,
        }),
      );
    }
    const fixture = new MemcachedFixture(server, oracle, resources);
    await fixture.init();
    for (const name of ["packages.txt", "debs.sha256", "artifacts.sha256", "compiler.txt", "os-release"]) {
      const receipt = await oracle.exec(["cat", `/oracle/receipts/${name}`]);
      if (receipt.exitCode !== 0 || receipt.output.length > 262144) {
        throw new Error("Native Memcached acquisition receipt unavailable or too large.");
      }
      console.log(JSON.stringify({ memcachedNativeAcquisition: name, value: receipt.output }));
    }
    return fixture;
  } catch (reason) {
    for (const id of ids) {
      try {
        console.error(
          "Memcached fixture bootstrap:",
          execFileSync("docker", ["logs", id], { encoding: "utf8", timeout: 10_000, maxBuffer: 1048576 }),
        );
      } catch (failure) {
        console.error("Memcached bootstrap diagnostics unavailable:", failure);
      }
    }
    await close(resources.reverse(), [reason]);
    throw reason;
  }
}
