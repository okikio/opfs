import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createConnection } from "node:net";
import type { Socket } from "node:net";
import { inflateRawSync } from "node:zlib";
import { openZip } from "../../src/archive/zip.ts";
import { close } from "../../src/close.ts";
import { readResponse } from "../../src/response.ts";
import { sourceRange } from "../../src/source.ts";
import { collectBytes } from "../../src/stream.ts";
import type { RedisChannelType } from "../../src/redis.ts";
import type { StartedTestContainer } from "testcontainers";

export const REDIS_IMAGE = "redis:8.10.3@sha256:f245f4c83b84a9e9a0588da1c9456e579455310f0945d5db52cd2ba27f2000cc";
export const VALKEY_IMAGE =
  "valkey/valkey:9.1.3@sha256:3add1a336a920ea54770a001ab6feb3da5fceea96a40373a3a2cd469b815f0b7";
export const REDIS_ORACLE_IMAGE =
  "python:3.13.12-slim-bookworm@sha256:a58daefb915e1e03ad48f3ca4df8832065412c5c35cacb9d39f4229184de12b6";
const WHEEL_SHA = "a4fe1aac3d3b3cc791d4b3d5931c5a956045dc951ee74d1c913ee3ac4d2ee9fb";
const PASSWORD = "fixture-only-redis";
interface RedisOracleType {
  readonly bytes: Buffer;
  readonly members: readonly { readonly name: string; readonly size: number; readonly sha256?: string }[];
  readonly notices: readonly { readonly name: string; readonly base64: string; readonly sha256: string }[];
}
/** Acquisition/inspection only. Separate approval is required before downloading or importing this test-only SDK. */
export async function acquireRedisOracle(save?: (bytes: Uint8Array) => void): Promise<RedisOracleType> {
  const signal = AbortSignal.timeout(30_000);
  const response = await fetch(
    "https://files.pythonhosted.org/packages/66/9d/c5731f6e3608663d4d3656fd8d3aecee8b509c3082818f5a13eae925baea/redis-8.1.0-py3-none-any.whl",
    { signal, redirect: "error", credentials: "omit", referrerPolicy: "no-referrer" },
  );
  if (response.status !== 200 || response.body === null) {
    await readResponse(response, () => {
      throw new Error("Independent redis-py wheel acquisition failed.");
    });
  }
  const bytes = await collectBytes(response.body!, 1048576, signal, "read", "redis-py wheel");
  return await inspectRedisOracle(bytes, save);
}
/** Offline inspection of the exact already acquired artifact. No dependency/source import or SDK code execution occurs. */
export async function inspectRedisOracle(
  input: Uint8Array,
  save?: (bytes: Uint8Array) => void,
): Promise<RedisOracleType> {
  if (input.length !== 560618) throw new Error("Independent redis-py wheel size differs from the pinned artifact.");
  const bytes = new Uint8Array(input);
  if (bytes.length !== 560618 || createHash("sha256").update(bytes).digest("hex") !== WHEEL_SHA) {
    throw new Error("Independent redis-py wheel differs from the pinned artifact.");
  }
  // Save a detached copy only after raw identity admission, so diagnostics can reuse the exact artifact without another download.
  save?.(new Uint8Array(bytes));
  // Project ZIP is bounded acquisition tooling, not an independent RESP oracle. Native zlib bounds each DEFLATE output.
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
  for (const entry of archive.entries) {
    const name = entry.name.endsWith("/") ? entry.name.slice(0, -1) : entry.name;
    if (
      name.length > 4096 || name.startsWith("/") || name.includes("\\") ||
      [...name].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127) ||
      name.split("/").some((part) => part === "" || part === "." || part === "..") || seen.has(name) ||
      !(name === "redis" || name.startsWith("redis/") || name === "redis-8.1.0.dist-info" ||
        name.startsWith("redis-8.1.0.dist-info/")) ||
      entry.kind !== "file" && entry.kind !== "directory" || entry.encrypted || ![0, 8].includes(entry.method) ||
      entry.size > 1048576 || entry.kind === "directory" && entry.size !== 0
    ) throw new Error("Independent redis-py wheel has unsupported members.");
    seen.add(name);
    total += entry.size;
    if (total > 8 * 1048576) throw new Error("Independent redis-py expansion exceeds policy.");
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
    if (name === "redis-8.1.0.dist-info/METADATA") {
      const content = new TextDecoder("utf-8", { fatal: true }).decode(result.bytes);
      if (!/^Name: redis$/mu.test(content) || !/^Version: 8\.1\.0$/mu.test(content)) {
        throw new Error("Independent wheel identity differs.");
      }
      const dependencies = content.split("\n").filter((line) => line.startsWith("Requires-Dist:"));
      // Exact pinned wheel spelling, not a partial PEP 508 interpreter. The native oracle separately requires Python 3.13.12 and no extras.
      const expected = [
        "Requires-Dist: async-timeout>=4.0.3; python_full_version < '3.11.3'",
        "Requires-Dist: pybreaker>=1.4.0; extra == 'circuit-breaker'",
        "Requires-Dist: hiredis>=3.2.0; extra == 'hiredis'",
        "Requires-Dist: pyjwt>=2.13.0; extra == 'jwt'",
        "Requires-Dist: cryptography>=36.0.1; extra == 'ocsp'",
        "Requires-Dist: pyopenssl>=20.0.1; extra == 'ocsp'",
        "Requires-Dist: requests>=2.31.0; extra == 'ocsp'",
        "Requires-Dist: opentelemetry-api>=1.39.1; extra == 'otel'",
        "Requires-Dist: opentelemetry-exporter-otlp-proto-http>=1.39.1; extra == 'otel'",
        "Requires-Dist: opentelemetry-sdk>=1.39.1; extra == 'otel'",
        "Requires-Dist: xxhash~=3.6.0; extra == 'xxhash'",
      ];
      if (dependencies.length !== expected.length || dependencies.some((line, index) => line !== expected[index])) {
        throw new Error("Independent wheel has an unexpected active dependency.", { cause: dependencies });
      }
      metadata = true;
    }
  }
  if (!metadata || notices.length === 0) throw new Error("Independent wheel metadata or notices are missing.");
  return { bytes: Buffer.from(bytes), members, notices };
}
/** No extras or hiredis: independent redis-py RESP2 bytes, with all retries explicitly disabled. */
const ORACLE = `import sys,base64,json
from pathlib import Path
if sys.version_info[:3]!=(3,13,12):raise RuntimeError('independent Python version differs')
import redis
from redis.retry import Retry
from redis.backoff import NoBackoff
if redis.__version__!='8.1.0':raise RuntimeError('independent SDK version differs')
client=redis.Redis(host='redis.test',port=6379,username='opfs',password='fixture-only-redis',db=3,
 protocol=2,decode_responses=False,socket_timeout=5,socket_connect_timeout=5,retry=Retry(NoBackoff(),0))
try:
 op=sys.argv[1]
 if op=='init':result={'sdk':redis.__version__,'python':sys.version.split()[0],'ping':client.ping()}
 else:
  key=Path('/oracle/key.bin').read_bytes()
  if len(key)>1024:raise RuntimeError('independent key exceeds policy')
  if op=='seed':
   value=Path('/oracle/value.bin').read_bytes()
   if len(value)>1048576:raise RuntimeError('independent bytes exceed policy')
   result={'stored':client.set(key,value)}
  elif op=='read':
   value=client.get(key)
   result={'missing':value is None,'base64':None if value is None else base64.b64encode(value).decode('ascii'),'ttl':str(client.pttl(key))}
  else:raise RuntimeError('unsupported independent operation')
 print('RECEIPT:'+json.dumps(result,separators=(',',':')))
finally:client.close()
`;
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
    const result = await this.#oracle.exec(["timeout", "20", "python", "-I", "/oracle/oracle.py", operation]);
    if (result.exitCode !== 0 || result.output.length > 2 * 1048576) {
      throw new Error("Independent redis-py operation failed.", { cause: result.output.slice(0, 65536) });
    }
    const lines = result.output.split(/\r?\n/u).filter((line) => line.startsWith("RECEIPT:"));
    if (lines.length !== 1) throw new Error("Independent redis-py receipt is missing or duplicated.");
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
      { content: Buffer.from(key), target: "/oracle/key.bin" },
      { content: Buffer.from(bytes), target: "/oracle/value.bin" },
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
    ], { input: Buffer.from(bytes), encoding: "utf8", timeout: 10_000, maxBuffer: 65536 });
    if (output.trim() !== "OK") throw new Error("Native Redis CLI seed lacks acknowledgement.");
  }
  async read(key: Uint8Array): Promise<{ readonly bytes: Uint8Array<ArrayBuffer> | null; readonly ttl: string }> {
    if (key.length > 1024) throw new Error("Independent Redis fixture key exceeds policy.");
    await this.#oracle.copyContentToContainer([{ content: Buffer.from(key), target: "/oracle/key.bin" }]);
    const value = await this.#run("read");
    if (typeof value.missing !== "boolean" || typeof value.ttl !== "string") throw new Error("Invalid oracle state.");
    if (value.missing) {
      if (value.base64 !== null) throw new Error("Missing independent Redis key has bytes.");
      return { bytes: null, ttl: value.ttl };
    }
    if (typeof value.base64 !== "string" || value.base64.length > 1398104) throw new Error("Invalid oracle bytes.");
    return { bytes: new Uint8Array(Buffer.from(value.base64, "base64")), ttl: value.ttl };
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
/** Separate recipe/acquisition approval is required. Each call owns one native server, one SDK container and a private network. */
export async function openRedis(kind: "redis" | "valkey"): Promise<RedisFixture> {
  const acquired = await acquireRedisOracle();
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
    const oracle = await new OwnedContainer(REDIS_ORACLE_IMAGE).withNetwork(network).withCopyContentToContainer([
      { content: acquired.bytes, target: "/oracle/redis-8.1.0-py3-none-any.whl" },
      {
        content: `/oracle/redis-8.1.0-py3-none-any.whl --hash=sha256:${WHEEL_SHA}\n`,
        target: "/oracle/requirements.txt",
      },
      { content: ORACLE, target: "/oracle/oracle.py" },
    ]).withCommand([
      "sh",
      "-c",
      "timeout 45 python -I -m pip install --no-index --no-deps --require-hashes --no-compile --disable-pip-version-check -r /oracle/requirements.txt && touch /oracle/ready && exec sleep 600",
    ]).withResourcesQuota({ memory: 0.25, cpu: 0.5 })
      .withWaitStrategy(Wait.forSuccessfulCommand("test -f /oracle/ready")).withStartupTimeout(60_000).start();
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
