import { createConnection } from "node:net";
import { Buffer } from "node:buffer";
import type { Socket } from "node:net";
import { connect as secureConnection, TLSSocket } from "node:tls";
import { fileURLToPath } from "node:url";
import type { StartedTestContainer } from "testcontainers";
import type { FtpOptionsType, FtpSocketType, FtpTransportType } from "../../src/ftp.ts";
import { close } from "../close.ts";

export const FTP_BYTES = "independent native libcurl bytes";
const PORT = 2121;
const PASSIVE = 30000;

/** A native event wait removes every listener when any terminal event wins. */
function event(socket: Socket, success: "connect" | "secureConnect" | "finish", signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      socket.off(success, ready);
      socket.off("error", error);
      socket.off("close", ended);
      signal.removeEventListener("abort", abort);
    };
    const ready = () => {
      cleanup();
      resolve();
    };
    const error = (reason: Error) => {
      cleanup();
      reject(reason);
    };
    const ended = () => error(new Error("Fixture socket closed before its event."));
    const abort = () => {
      cleanup();
      socket.destroy();
      reject(signal.reason);
    };
    socket.once(success, ready);
    socket.once("error", error);
    socket.once("close", ended);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
}

/**
 * Lazy pull uses readable-mode sockets, with no eager data listener/read-ahead.
 * This is essential at AUTH TLS: an idle plaintext stream cannot consume bytes
 * meant for the TLS layer after the client releases its reader lock.
 */
function wrap(socket: Socket, peerAddress: string): FtpSocketType {
  socket.on("error", () => {});
  return {
    peerAddress,
    readable: new ReadableStream<Uint8Array>({
      pull(controller) {
        return new Promise<void>((resolve, reject) => {
          const cleanup = () => {
            socket.off("readable", read);
            socket.off("end", read);
            socket.off("close", read);
            socket.off("error", error);
          };
          const error = (reason: Error) => {
            cleanup();
            reject(reason);
          };
          const read = () => {
            const bytes: unknown = socket.read();
            if (bytes instanceof Uint8Array) {
              cleanup();
              controller.enqueue(new Uint8Array(bytes));
              resolve();
            } else if (socket.readableEnded) {
              cleanup();
              controller.close();
              resolve();
            } else if (socket.destroyed) error(new Error("Fixture data connection ended abruptly."));
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
      async close() {
        const finished = event(socket, "finish", AbortSignal.timeout(5000));
        socket.end();
        await finished;
      },
      abort() {
        socket.destroy();
      },
    }),
    close() {
      if (socket.destroyed) return Promise.resolve();
      return new Promise<void>((resolve) => {
        socket.once("close", () => resolve());
        socket.destroy();
      });
    },
  };
}

/** One unprivileged native ProFTPD server. Testcontainers owns build/start and mapped ports. */
export class FtpFixture implements AsyncDisposable {
  readonly #container: StartedTestContainer;
  readonly #certificate: string;
  #closing: Promise<void> | undefined;
  readonly tls = { controls: 0, data: 0, reused: 0 };
  /** Actual source, package and binary receipts from this fixture build/start. */
  readonly provenance: string;
  constructor(container: StartedTestContainer, certificate: string, provenance: string) {
    this.#container = container;
    this.#certificate = certificate;
    this.provenance = provenance;
  }
  close(): Promise<void> {
    return this.#closing ??= Promise.resolve().then(async () => {
      await this.#container.stop();
    });
  }
  [Symbol.asyncDispose](): Promise<void> {
    return this.close();
  }
  /**
   * Only this fixture translates the internal passive port to its mapped port.
   * The native client still asks for the identical concrete peer address.
   */
  options(mode: "plain" | "explicit-tls", trust = true): FtpOptionsType {
    const container = this.#container;
    const host = container.getHost();
    const sockets = new WeakMap<FtpSocketType, Socket>();
    const transport: FtpTransportType = {
      connect: async ({ host: requested, port, signal }) => {
        const target = port === PASSIVE || port === PASSIVE + 1 ? container.getMappedPort(port) : port;
        const raw = createConnection({ host: requested, port: target });
        raw.on("error", () => {});
        await event(raw, "connect", signal);
        const connection = wrap(raw, raw.remoteAddress!);
        sockets.set(connection, raw);
        return connection;
      },
      secure: async (connection, options) => {
        const raw = sockets.get(connection);
        if (!raw) throw new Error("Unknown fixture socket owner.");
        const control = options.controlSecurity;
        const tls = secureConnection({
          socket: raw,
          servername: "localhost",
          ...(trust ? { ca: this.#certificate } : {}),
          rejectUnauthorized: true,
          ...(options.role === "data" && control instanceof TLSSocket && control.getSession()
            ? { session: control.getSession()! }
            : {}),
          minVersion: "TLSv1.2",
          maxVersion: "TLSv1.2",
        });
        tls.on("error", () => {});
        await event(tls, "secureConnect", options.signal);
        if (!tls.authorized) throw new Error("Fixture TLS certificate was not authorized.");
        if (options.role === "control") this.tls.controls++;
        else {
          this.tls.data++;
          if (!tls.isSessionReused()) {
            tls.destroy();
            throw new Error("FTPS data session was not bound by TLS resumption.");
          }
          this.tls.reused++;
        }
        const protectedSocket = wrap(tls, connection.peerAddress);
        sockets.set(protectedSocket, tls);
        return { socket: protectedSocket, context: tls };
      },
    };
    return {
      host,
      port: container.getMappedPort(PORT),
      username: "fixture",
      password: "test-only-password",
      mode,
      transport,
      timeoutMs: 10_000,
    };
  }
  /** Native libcurl independently seeds the server through STOR with stdin bytes. */
  async seed(): Promise<void> {
    const result = await this.#container.exec([
      "node",
      "/fixture/client.ts",
      "seed",
      Buffer.from(FTP_BYTES).toString("base64"),
    ]);
    if (result.exitCode !== 0) throw new Error(`Independent FTP producer failed: ${result.output}`);
  }
  /** Independent libcurl RETR verifies candidate uploads through a separate protocol implementation. */
  async read(path: string): Promise<string> {
    const result = await this.#container.exec([
      "node",
      "/fixture/client.ts",
      "read",
      path,
    ]);
    if (result.exitCode !== 0) throw new Error(`Independent FTP reader failed: ${result.output}`);
    return result.stdout;
  }
  /** Native 550 refusals must cover directory traversal, world-readable files and writable /tmp. */
  async outside(): Promise<string> {
    const result = await this.#container.exec(["node", "/fixture/client.ts", "deny-outside"]);
    if (result.exitCode !== 0) throw new Error(`Independent FTP confinement check failed: ${result.output}`);
    return result.stdout;
  }
}

export async function openFtp(): Promise<FtpFixture> {
  const { GenericContainer, Wait } = await import("testcontainers");
  const built = await GenericContainer.fromDockerfile(fileURLToPath(new URL("../fixtures/ftp/", import.meta.url).href))
    .build();
  // Readiness can fail before Testcontainers returns an owned container handle.
  // Capture a finite prefix while its log stream still exists, without changing native configuration.
  const startup: Buffer[] = [];
  let startupBytes = 0;
  const capture = (chunk: unknown): void => {
    const remaining = 256 * 1024 - startupBytes;
    if (remaining <= 0) return;
    const bytes = (chunk instanceof Uint8Array ? Buffer.from(chunk) : Buffer.from(String(chunk))).subarray(
      0,
      remaining,
    );
    startup.push(Buffer.from(bytes));
    startupBytes += bytes.length;
  };
  let container: StartedTestContainer;
  try {
    container = await built.withExposedPorts(PORT, PASSIVE, PASSIVE + 1)
      .withDroppedCapabilities("ALL").withSecurityOpt("no-new-privileges")
      .withResourcesQuota({ memory: 0.5, cpu: 1 })
      .withLogConsumer((stream) => {
        stream.on("data", capture);
        stream.on("err", capture);
      })
      .withWaitStrategy(Wait.forLogMessage("OPFS FTP fixture ready")).withStartupTimeout(90_000).start();
  } catch (reason) {
    console.error("Native FTP startup diagnostics (at most 256 KiB):", Buffer.concat(startup).toString());
    throw reason;
  }
  try {
    const certificate = await container.exec(["cat", "/tmp/ftp-control/cert.pem"]);
    if (certificate.exitCode !== 0) throw new Error("Fixture certificate was unavailable.");
    const provenance = await container.exec(["cat", "/tmp/ftp-provenance.json"]);
    if (provenance.exitCode !== 0 || provenance.stdout.length > 1024 * 1024) {
      throw new Error("Fixture provenance was unavailable or exceeded its budget.");
    }
    JSON.parse(provenance.stdout);
    const fixture = new FtpFixture(container, certificate.stdout, provenance.stdout);
    await fixture.seed();
    return fixture;
  } catch (reason) {
    await close([() => container.stop()], [reason]);
    throw reason;
  }
}
