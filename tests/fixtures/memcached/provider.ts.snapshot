import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { inflateRawSync } from "node:zlib";
import { createConnection } from "node:net";
import type { Socket } from "node:net";
import { execFileSync } from "node:child_process";
import { openZip } from "../../src/archive/zip.ts";
import { collectBytes } from "../../src/stream.ts";
import { readResponse } from "../../src/response.ts";
import { sourceRange } from "../../src/source.ts";
import { close } from "../../src/close.ts";
import type { MemcachedChannelType } from "../../src/memcached.ts";
import type { StartedTestContainer } from "testcontainers";

export const MEMCACHED_IMAGE =
  "memcached:1.6.45-alpine@sha256:6a089e37cbb8acd75c80c6c0667fe57ec54db68782fb1b3afb1d0eb265e50070";
export const MEMCACHED_ORACLE_IMAGE =
  "python:3.13.12-slim-bookworm@sha256:a58daefb915e1e03ad48f3ca4df8832065412c5c35cacb9d39f4229184de12b6";
const WHEEL_SHA = "f507bc20e0dc8d562f8df9d872107a278df049fa496805c1431b926f3ddd0eab";
/** Exact published no-dependency wheel; download/inspection approval is separate from importing or executing it. */
export async function acquireMemcachedOracle(): Promise<{
  readonly bytes: Buffer;
  readonly members: readonly { readonly name: string; readonly size: number; readonly sha256?: string }[];
}> {
  const signal = AbortSignal.timeout(30_000);
  const response = await fetch(
    "https://files.pythonhosted.org/packages/41/ba/2f7b22d8135b51c4fefb041461f8431e1908778e6539ff5af6eeaaee367a/pymemcache-4.0.0-py2.py3-none-any.whl",
    {
      redirect: "error",
      credentials: "omit",
      referrerPolicy: "no-referrer",
      signal,
    },
  );
  if (response.status !== 200 || response.body === null) {
    await readResponse(response, () => {
      throw new Error("Independent pymemcache wheel acquisition failed.");
    });
  }
  const bytes = await collectBytes(response.body!, 65536, signal, "read", "pymemcache wheel");
  if (bytes.length !== 60772 || createHash("sha256").update(bytes).digest("hex") !== WHEEL_SHA) {
    throw new Error("Independent pymemcache wheel differs from its published hash.");
  }
  // Existing project ZIP is acquisition tooling only, not a Memcached protocol oracle. Native zlib bounds each raw DEFLATE output.
  const archive = await openZip({
    size: bytes.length,
    stability: "immutable",
    read: async (at, length) => {
      sourceRange(bytes.length, at, length);
      return bytes.slice(at, at + length);
    },
  }, {
    maxEntries: 256,
    maxDirectoryBytes: 131072,
    maxSourceBytes: 4 * 1048576,
    maxDecodedBytes: 4 * 1048576,
    maxOutputBytes: 4 * 1048576,
    maxRequests: 2048,
  });
  const seen = new Set<string>(), members: { name: string; size: number; sha256?: string }[] = [];
  let total = 0, metadata = false;
  for (const entry of archive.entries) {
    const name = entry.name.endsWith("/") ? entry.name.slice(0, -1) : entry.name;
    if (
      name.length > 4096 || name.includes("\\") || name.startsWith("/") || [...name].some((character) =>
        character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127
      ) ||
      name.split("/").some((part) => part === "" || part === "." || part === "..") || seen.has(name) ||
      !(name === "pymemcache" || name.startsWith("pymemcache/") || name === "pymemcache-4.0.0.dist-info" ||
        name.startsWith("pymemcache-4.0.0.dist-info/")) ||
      entry.kind !== "file" && entry.kind !== "directory" || entry.encrypted || ![0, 8].includes(entry.method) ||
      entry.size > 524288 || entry.kind === "directory" && entry.size !== 0
    ) throw new Error("Independent wheel has unsupported members or paths.");
    seen.add(name);
    total += entry.size;
    if (total > 4 * 1048576) throw new Error("Independent wheel expansion exceeds policy.");
    if (entry.kind === "directory") {
      members.push({ name, size: 0 });
      continue;
    }
    const inflated = await archive.read(entry.id, {
      verify: true,
      maxSourceBytes: 65536,
      maxDecodedBytes: 524288,
      maxOutputBytes: 524288,
      maxRequests: 32,
      inflate: () => {
        const chunks: Buffer[] = [];
        let compressed = 0;
        return new TransformStream<Uint8Array, Uint8Array>({
          transform(chunk) {
            compressed += chunk.length;
            if (compressed > 65536) throw new Error("Wheel DEFLATE input exceeds policy.");
            chunks.push(Buffer.from(chunk));
          },
          flush(controller) {
            controller.enqueue(new Uint8Array(inflateRawSync(Buffer.concat(chunks), { maxOutputLength: 524288 })));
          },
        });
      },
    });
    if (inflated.integrity !== "checksum-verified") throw new Error("Independent wheel CRC was not checked.");
    members.push({
      name,
      size: inflated.bytes.length,
      sha256: createHash("sha256").update(inflated.bytes).digest("hex"),
    });
    if (name === "pymemcache-4.0.0.dist-info/METADATA") {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(inflated.bytes);
      if (!/^Name: pymemcache$/mu.test(text) || !/^Version: 4\.0\.0$/mu.test(text) || /^Requires-Dist:/mu.test(text)) {
        throw new Error("Independent wheel metadata does not match the no-dependency recipe.");
      }
      metadata = true;
    }
  }
  if (!metadata) throw new Error("Independent wheel metadata is absent.");
  return { bytes: Buffer.from(bytes), members };
}
/** Independent client deliberately disables its default noreply=True; each tested write must have a native terminal receipt. */
const ORACLE = `import sys,base64,json
from pathlib import Path
from pymemcache.client.base import Client
client=Client(('memcached.test',11211),connect_timeout=5,timeout=10,default_noreply=False)
try:
 op=sys.argv[1]
 if op=='init':
  version=client.version().decode('ascii')
  if version!='1.6.45':raise RuntimeError('native version mismatch')
  print('VERSION:'+version)
 elif op=='seed':
  value=Path('/oracle/input.bin').read_bytes()
  if len(value)>1048576:raise RuntimeError('fixture input policy')
  if client.set(sys.argv[2],value,expire=0,flags=4294967295,noreply=False) is not True:raise RuntimeError('native set refusal')
  print('STORED:true')
 elif op=='read':
  value,cas=client.gets(sys.argv[2])
  if value is None:print('MISSING:true')
  else:
   if len(value)>1048576:raise RuntimeError('fixture output policy')
   print('BYTES:'+base64.b64encode(value).decode('ascii'))
   print('CAS:'+cas.decode('ascii'))
 else:raise RuntimeError('unsupported independent operation')
finally:client.close()
`;
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
    const result = await this.#oracle.exec(["timeout", "20", "python", "-I", "/oracle/oracle.py", ...args]);
    if (result.exitCode !== 0 || result.output.length > 2 * 1048576) {
      throw new Error(`Independent pymemcache failed: ${result.output.slice(0, 8192)}`);
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
/** Recipe approval is required before acquisition or execution; private ephemeral server and independently implemented Python client only. */
export async function openMemcached(): Promise<MemcachedFixture> {
  const acquired = await acquireMemcachedOracle();
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
    const network = await new Network().start();
    resources.push(() => network.stop());
    const server = await new OwnedContainer(MEMCACHED_IMAGE).withNetwork(network).withNetworkAliases("memcached.test")
      .withCommand(["memcached", "-m", "16", "-I", "1m", "-U", "0", "-t", "1"])
      .withExposedPorts(11211).withResourcesQuota({ memory: 0.125, cpu: 0.5 }).withWaitStrategy(
        Wait.forListeningPorts(),
      ).withStartupTimeout(45_000).start();
    resources.push(() => server.stop());
    const oracle = await new OwnedContainer(MEMCACHED_ORACLE_IMAGE).withNetwork(network).withCopyContentToContainer([
      { content: acquired.bytes, target: "/oracle/pymemcache-4.0.0-py2.py3-none-any.whl" },
      {
        content: `/oracle/pymemcache-4.0.0-py2.py3-none-any.whl --hash=sha256:${WHEEL_SHA}\n`,
        target: "/oracle/requirements.txt",
      },
      { content: ORACLE, target: "/oracle/oracle.py" },
    ]).withCommand([
      "sh",
      "-c",
      "timeout 45 python -I -m pip install --no-index --no-deps --require-hashes --no-compile --disable-pip-version-check -r /oracle/requirements.txt && touch /oracle/ready && exec sleep 600",
    ])
      .withResourcesQuota({ memory: 0.5, cpu: 0.5 }).withWaitStrategy(
        Wait.forSuccessfulCommand("test -f /oracle/ready"),
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
