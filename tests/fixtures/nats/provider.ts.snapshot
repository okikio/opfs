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
import type { NatsChannelType } from "../../src/nats.ts";
import type { StartedTestContainer } from "testcontainers";

export const NATS_IMAGE = "nats:2.15.2@sha256:991242c32d2738ffd358fd6614dd96c735017b4b3b34bfdb2c52a072d66db211";
export const NATS_ORACLE_IMAGE =
  "python:3.13.12-slim-bookworm@sha256:a58daefb915e1e03ad48f3ca4df8832065412c5c35cacb9d39f4229184de12b6";
const WHEEL_SHA = "aeb1ff123966c05833d26c7df7e1d54c1c6d32b612428b21677a2e921f1fecae";
interface NatsOracleType {
  readonly bytes: Buffer;
  readonly members: readonly { readonly name: string; readonly size: number; readonly sha256?: string }[];
  readonly notices: readonly { readonly name: string; readonly base64: string; readonly sha256: string }[];
}
/** Acquisition/inspection only. Separate approval is required before downloading or importing this test-only SDK. */
export async function acquireNatsOracle(save?: (bytes: Uint8Array) => void): Promise<NatsOracleType> {
  const signal = AbortSignal.timeout(30_000);
  const response = await fetch(
    "https://files.pythonhosted.org/packages/48/a3/16cec37172144d3362d7551bb823a098b2b2903281fc095dfe4480b8c2fd/nats_py-2.16.0-py3-none-any.whl",
    { signal, redirect: "error", credentials: "omit", referrerPolicy: "no-referrer" },
  );
  if (response.status !== 200 || response.body === null) {
    await readResponse(response, () => {
      throw new Error("Independent nats-py wheel acquisition failed.");
    });
  }
  const bytes = await collectBytes(response.body!, 1048576, signal, "read", "nats-py wheel");
  return await inspectNatsOracle(bytes, save);
}
/** Offline inspection of the exact already acquired artifact. No dependency/source import or SDK code execution occurs. */
export async function inspectNatsOracle(
  input: Uint8Array,
  save?: (bytes: Uint8Array) => void,
): Promise<NatsOracleType> {
  if (input.length !== 93578) throw new Error("Independent nats-py wheel size differs from the pinned artifact.");
  const bytes = new Uint8Array(input);
  if (bytes.length !== 93578 || createHash("sha256").update(bytes).digest("hex") !== WHEEL_SHA) {
    throw new Error("Independent nats-py wheel differs from the pinned artifact.");
  }
  // Save a detached copy only after raw identity admission, so diagnostics can reuse the exact artifact without another download.
  save?.(new Uint8Array(bytes));
  // Project ZIP is bounded acquisition tooling, not an independent NATS oracle. Native zlib bounds each DEFLATE output.
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
      !(name === "nats" || name.startsWith("nats/") || name === "nats_py-2.16.0.dist-info" ||
        name.startsWith("nats_py-2.16.0.dist-info/")) ||
      entry.kind !== "file" && entry.kind !== "directory" || entry.encrypted || ![0, 8].includes(entry.method) ||
      entry.size > 1048576 || entry.kind === "directory" && entry.size !== 0
    ) throw new Error("Independent nats-py wheel has unsupported members.");
    seen.add(name);
    total += entry.size;
    if (total > 8 * 1048576) throw new Error("Independent nats-py expansion exceeds policy.");
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
    if (name === "nats_py-2.16.0.dist-info/METADATA") {
      const content = new TextDecoder("utf-8", { fatal: true }).decode(result.bytes);
      if (!/^Name: nats-py$/mu.test(content) || !/^Version: 2\.16\.0$/mu.test(content)) {
        throw new Error("Independent wheel identity differs.");
      }
      const dependencies = content.split("\n").filter((line) => line.startsWith("Requires-Dist:"));
      // Exact observed immutable-wheel dependency lines, including spacing and
      // quote spelling. This is not a partial PEP 508 interpreter.
      // Native execution separately requires Python 3.13.12 and no extras.
      const expected = [
        "Requires-Dist: aiohttp ; extra == 'aiohttp'",
        "Requires-Dist: fast-mail-parser ; extra == 'fast-parse'",
        "Requires-Dist: nkeys ; extra == 'nkeys'",
      ];
      if (
        dependencies.length !== expected.length ||
        dependencies.some((line, index) => line !== expected[index])
      ) {
        throw new Error("Independent wheel dependency profile differs.", { cause: dependencies });
      }
      metadata = true;
    }
  }
  if (!metadata || notices.length === 0) throw new Error("Independent wheel metadata or notices are missing.");
  return { bytes: Buffer.from(bytes), members, notices };
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
/** Independent official SDK, Python version asserted before import; no TLS/NKeys/WebSocket extras or reconnect. */
const ORACLE = `import sys,base64,json,asyncio,importlib.metadata
from pathlib import Path
if sys.version_info[:3]!=(3,13,12):raise RuntimeError('independent Python version differs')
if importlib.metadata.version('nats-py')!='2.16.0':raise RuntimeError('independent SDK version differs')
import nats
from nats.js.api import StorageType
async def main():
 nc=await nats.connect('nats://nats.test:4222',user='oracle',password='fixture-only-oracle',allow_reconnect=False,max_reconnect_attempts=0,connect_timeout=5)
 try:
  js=nc.jetstream(timeout=5)
  op=sys.argv[1]
  if op=='init':
   await js.add_stream(name='OWNED',subjects=['owned.data'],storage=StorageType.MEMORY,max_bytes=4194304,max_msgs=64,max_msg_size=1048576)
   await js.add_stream(name='OTHER',subjects=['other.data'],storage=StorageType.MEMORY,max_bytes=4194304,max_msgs=64,max_msg_size=1048576)
   result={'sdk':importlib.metadata.version('nats-py'),'python':sys.version.split()[0],'version':nc.connected_server_version}
  elif op=='seed':
   data=Path('/oracle/value.bin').read_bytes()
   if len(data)>1048576:raise RuntimeError('independent bytes exceed policy')
   ack=await js.publish('owned.data',data)
   result={'stream':ack.stream,'sequence':str(ack.seq),'duplicate':ack.duplicate}
  elif op=='read':
   seq=sys.argv[2]
   if len(seq)>20 or not seq.isdecimal():raise RuntimeError('independent sequence exceeds policy')
   msg=await js.get_msg('OWNED',seq=int(seq))
   result={'subject':msg.subject,'sequence':str(msg.seq),'base64':base64.b64encode(msg.data).decode('ascii')}
  elif op=='other':
   state=await js.stream_info('OTHER')
   result={'messages':str(state.state.messages)}
  else:raise RuntimeError('unsupported independent operation')
  print('RECEIPT:'+json.dumps(result,separators=(',',':'),default=str))
 finally:await nc.close()
asyncio.run(main())
`;
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
    const command = ["timeout", "20", "python", "-I", "/oracle/oracle.py", operation];
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
    console.log(JSON.stringify({ nativeVersion: result.output.trim(), oracle: await this.#run("init") }));
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
/** Exact fixture and artifact acquisition need separate approval before this function is executed. */
export async function openNats(wheel?: Uint8Array): Promise<NatsFixture> {
  const acquired = wheel === undefined ? await acquireNatsOracle() : await inspectNatsOracle(wheel);
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
    const oracle = await new OwnedContainer(NATS_ORACLE_IMAGE).withNetwork(network).withCopyContentToContainer([
      { content: acquired.bytes, target: "/oracle/nats_py-2.16.0-py3-none-any.whl" },
      {
        content: `/oracle/nats_py-2.16.0-py3-none-any.whl --hash=sha256:${WHEEL_SHA}\n`,
        target: "/oracle/requirements.txt",
      },
      { content: ORACLE, target: "/oracle/oracle.py" },
    ]).withCommand([
      "sh",
      "-c",
      "timeout 45 python -I -m pip install --no-index --no-deps --require-hashes --no-compile --disable-pip-version-check -r /oracle/requirements.txt && touch /oracle/ready && exec sleep 600",
    ])
      .withResourcesQuota({ memory: 0.25, cpu: 0.5 }).withWaitStrategy(
        Wait.forSuccessfulCommand("test -f /oracle/ready"),
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
