import { createConnection } from "node:net";
import type { Socket } from "node:net";
import { connect as secureConnection, TLSSocket } from "node:tls";
import { fileURLToPath } from "node:url";
import type { StartedTestContainer } from "testcontainers";
import type { FtpOptionsType, FtpSocketType, FtpTransportType } from "../../src/ftp.ts";
import { close } from "../close.ts";

export const FTP_BYTES = "independent Python ftplib bytes";
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

/** One unprivileged pyftpdlib server. Testcontainers owns build/start and all mapped ports. */
export class FtpFixture implements AsyncDisposable {
  readonly #container: StartedTestContainer;
  readonly #certificate: string;
  #closing: Promise<void> | undefined;
  readonly tls = { controls: 0, data: 0, reused: 0 };
  constructor(container: StartedTestContainer, certificate: string) {
    this.#container = container;
    this.#certificate = certificate;
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
        const target = port === PASSIVE ? container.getMappedPort(PASSIVE) : port;
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
  /** Python's standard ftplib independently seeds the server via real STOR. */
  async seed(): Promise<void> {
    const result = await this.#container.exec([
      "python",
      "-c",
      [
        "import ftplib, io",
        "ftp=ftplib.FTP(); ftp.connect('127.0.0.1',2121,timeout=10); ftp.login('fixture','test-only-password')",
        `ftp.storbinary('STOR producer.txt',io.BytesIO(${JSON.stringify(FTP_BYTES)}.encode()))`,
        "ftp.mkd('folder'); ftp.quit()",
      ].join("\n"),
    ]);
    if (result.exitCode !== 0) throw new Error(`Independent FTP producer failed: ${result.output}`);
  }
  /** Independent ftplib RETR verifies candidate uploads, not its own read implementation. */
  async read(path: string): Promise<string> {
    const result = await this.#container.exec([
      "python",
      "-c",
      [
        "import ftplib,sys",
        "ftp=ftplib.FTP(); ftp.connect('127.0.0.1',2121,timeout=10); ftp.login('fixture','test-only-password')",
        "parts=[]; ftp.retrbinary('RETR '+sys.argv[1],parts.append); ftp.quit(); print(b''.join(parts).decode(),end='')",
      ].join("\n"),
      path,
    ]);
    if (result.exitCode !== 0) throw new Error(`Independent FTP reader failed: ${result.output}`);
    return result.stdout;
  }
}

export async function openFtp(): Promise<FtpFixture> {
  const { GenericContainer, Wait } = await import("testcontainers");
  const built = await GenericContainer.fromDockerfile(fileURLToPath(new URL("../fixtures/ftp/", import.meta.url).href))
    .build();
  const container = await built.withExposedPorts(PORT, PASSIVE)
    .withDroppedCapabilities("ALL").withSecurityOpt("no-new-privileges")
    .withResourcesQuota({ memory: 0.5, cpu: 1 })
    .withWaitStrategy(Wait.forLogMessage("OPFS FTP fixture ready")).withStartupTimeout(90_000).start();
  try {
    const certificate = await container.exec(["cat", "/tmp/ftp-cert.pem"]);
    if (certificate.exitCode !== 0) throw new Error("Fixture certificate was unavailable.");
    const fixture = new FtpFixture(container, certificate.stdout);
    await fixture.seed();
    return fixture;
  } catch (reason) {
    await close([() => container.stop()], [reason]);
    throw reason;
  }
}
