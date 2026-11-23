/** Explicitly admitted, private local Vercel SDK/emulator qualification. Acquired modules never load in this process. */
import { Buffer } from "node:buffer";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { StartedTestContainer } from "testcontainers";
import { close } from "../../close.ts";
import { VERCEL_ARTIFACTS, VERCEL_ROOTS } from "./artifacts.ts";
import { VERCEL_ORACLE, VERCEL_SERVER, VERCEL_WRITER } from "./programs.ts";

/** The existing reviewed Node26 fixture image; no source build or package hook is invoked. */
export const VERCEL_IMAGE =
  "node:26.13.0-bookworm-slim@sha256:add5c17c14752c54d2f3d519ec46a3815684d41c33f198bcb09fb998f7dcbf68";
/** A hash identifies the complete owner-reviewed evidence; it is not an automatic execution or license approval. */
export interface VercelAdmissionType {
  readonly directory: string;
  readonly closureSha256: string;
  readonly reviewedForTestExecution: true;
}
interface ContentType {
  readonly content: Buffer<ArrayBuffer> | string;
  readonly target: string;
  readonly mode: number;
}
function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Expected Vercel evidence object.");
  }
  return value as Record<string, unknown>;
}
function hash(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
function read(path: string, maximum: number): Buffer<ArrayBuffer> {
  const info = lstatSync(path);
  if (!info.isFile() || info.size < 0 || info.size > maximum) {
    throw new Error("Vercel evidence must be a bounded regular file.");
  }
  const bytes = readFileSync(path);
  if (bytes.length !== info.size) throw new Error("Vercel evidence changed during admission.");
  return bytes;
}
/** Materialize the two reachable graphs separately, preserving jose5/jose6 without aliases or symlinks. */
function copies(admission: VercelAdmissionType): ContentType[] {
  if (admission.reviewedForTestExecution !== true || !/^[0-9a-f]{64}$/.test(admission.closureSha256)) {
    throw new Error("Explicit reviewed Vercel closure required.");
  }
  const root = resolve(admission.directory), raw = read(join(root, "closure.json"), 4 * 1048576);
  if (hash(raw) !== admission.closureSha256) throw new Error("Vercel execution admission hash differs.");
  const closure = object(JSON.parse(raw.toString("utf8")));
  if (
    !Array.isArray(closure.roots) || JSON.stringify(closure.roots) !== JSON.stringify(VERCEL_ROOTS) ||
    !Array.isArray(closure.packages) || closure.packages.length !== VERCEL_ARTIFACTS.length
  ) throw new Error("Wrong Vercel closure roots/count.");
  const packages = new Map<string, Record<string, unknown>>();
  for (const rawPackage of closure.packages) {
    const item = object(rawPackage);
    if (typeof item.id !== "string" || packages.has(item.id)) {
      throw new Error("Invalid or duplicate Vercel artifact identity.");
    }
    const pin = VERCEL_ARTIFACTS.find((pin) => pin.name + "@" + pin.version === item.id);
    if (!pin || item.integrity !== pin.integrity) throw new Error("Unpinned Vercel artifact identity.");
    const targets = object(item.targets);
    if (
      Object.keys(targets).length !== Object.keys(pin.targets).length ||
      Object.entries(pin.targets).some(([name, target]) => targets[name] !== target)
    ) throw new Error("Vercel dependency graph differs from reviewed targets.");
    packages.set(item.id, item);
  }
  const output: ContentType[] = [];
  let files = 0, bytes = 0;
  for (const [index, start] of VERCEL_ROOTS.entries()) {
    const lane = index === 0 ? "sdk" : "emulator", reached = new Set<string>(), names = new Set<string>();
    const visit = (id: string): void => {
      if (reached.has(id)) return;
      const item = packages.get(id), pin = VERCEL_ARTIFACTS.find((pin) => pin.name + "@" + pin.version === id);
      if (!item || !pin || names.has(pin.name) || !Array.isArray(item.members)) {
        throw new Error("Invalid Vercel namespace graph.");
      }
      reached.add(id);
      names.add(pin.name);
      const paths = new Set<string>();
      for (const rawMember of item.members) {
        const member = object(rawMember), path = member.path;
        if (
          typeof path !== "string" || path.length > 4096 || path.includes("\\") || path.includes("\0") ||
          path.split("/").some((part) => !part || part === "." || part === "..") || paths.has(path)
        ) throw new Error("Unsafe or duplicate Vercel member path.");
        paths.add(path);
        if (
          typeof member.bytes !== "number" || !Number.isSafeInteger(member.bytes) || member.bytes < 0 ||
          member.bytes > 8 * 1048576 || typeof member.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(member.sha256)
        ) throw new Error("Invalid Vercel member extent/hash.");
        if (++files > 12000 || member.bytes > 96 * 1048576 - bytes) throw new Error("Vercel materialization ceiling.");
        bytes += member.bytes;
        const content = read(
          join(root, "source", pin.name.replace("/", "__") + "@" + pin.version, path + ".snapshot"),
          member.bytes,
        );
        if (content.length !== member.bytes || hash(content) !== member.sha256) {
          throw new Error("Vercel member differs from admitted evidence.");
        }
        output.push({ content, target: "/fixture/" + lane + "/node_modules/" + pin.name + "/" + path, mode: 0o444 });
      }
      if (!paths.has("package.json")) throw new Error("Vercel materialization omitted package.json.");
      for (const target of Object.values(pin.targets)) visit(target);
    };
    visit(start);
  }
  output.push({
    content: JSON.stringify({
      closureSha256: admission.closureSha256,
      missingStandaloneNotices: closure.missingStandaloneNotices,
      review:
        "Explicit owner admission for offline test execution only; unresolved original notice gap retained, no full legal or production dependency approval.",
    }),
    target: "/fixture/admission.json",
    mode: 0o444,
  });
  return output;
}
/** Empty/null are the two Docker representations of absent bindings; missing fields do not establish isolation. */
function noPorts(value: unknown): boolean {
  return value === null ||
    (value !== undefined && typeof value === "object" && !Array.isArray(value) && Reflect.ownKeys(value).length === 0);
}

/** Copy admitted bytes through a fixed built-in-only writer, avoiding Docker archive extraction policy. */
function copy(contents: readonly ContentType[], id: string): void {
  if (contents.length > 12002) throw new Error("Vercel copy entry ceiling exceeded.");
  let total = 0;
  const names = new Set<string>();
  const entries = contents.map((item) => {
    if (!item.target.startsWith("/fixture/")) throw new Error("Vercel copy target escaped fixture mount.");
    const name = item.target.slice("/fixture/".length);
    if (
      !name || name.includes("\\") || name.includes("\0") ||
      name.split("/").some((part) => !part || part === "." || part === "..") ||
      name === "ready" || names.has(name)
    ) throw new Error("Invalid or duplicate Vercel copy identity.");
    names.add(name);
    const bytes = typeof item.content === "string" ? Buffer.from(item.content) : item.content;
    total += bytes.length;
    if (total > 24 * 1048576) throw new Error("Vercel copy payload ceiling exceeded.");
    return { name, size: bytes.length, sha256: hash(bytes), base64: bytes.toString("base64") };
  });
  const input = Buffer.from(JSON.stringify(entries));
  if (input.length > 32 * 1048576) throw new Error("Vercel serialized copy ceiling exceeded.");
  execFileSync("docker", [
    "exec",
    "-i",
    id,
    "timeout",
    "--signal=KILL",
    "60s",
    "node",
    "--max-old-space-size=128",
    "--input-type=module",
    "-e",
    VERCEL_WRITER,
  ], {
    input,
    timeout: 75000,
    maxBuffer: 131072,
  });
}
/** Read actual engine and tmpfs state instead of trusting requested resource flags. */
function inspect(id: string, running: boolean): void {
  const parsed: unknown = JSON.parse(
    execFileSync("docker", ["inspect", id], { encoding: "utf8", timeout: 10000, maxBuffer: 131072 }),
  );
  if (!Array.isArray(parsed) || parsed.length !== 1) throw new Error("Vercel engine inspection differs.");
  const value = object(parsed[0]),
    host = object(value.HostConfig),
    state = object(value.State),
    config = object(value.Config);
  const tmpfs = object(host.Tmpfs), log = object(host.LogConfig), limits = object(log.Config);
  if (
    config.Image !== VERCEL_IMAGE || config.User !== "65534:65534" || state.Running !== running ||
    state.OOMKilled !== false || host.Memory !== 1073741824 || host.MemorySwap !== 1073741824 ||
    host.NanoCpus !== 1000000000 || host.PidsLimit !== 256 || host.NetworkMode !== "none" ||
    host.Privileged !== false || host.ReadonlyRootfs !== true || host.PublishAllPorts !== false ||
    !noPorts(host.PortBindings) ||
    !Array.isArray(host.CapDrop) || !host.CapDrop.includes("ALL") || !Array.isArray(host.SecurityOpt) ||
    !host.SecurityOpt.includes("no-new-privileges") ||
    (host.CapAdd !== null && (!Array.isArray(host.CapAdd) || host.CapAdd.length !== 0)) ||
    (host.Binds !== null && (!Array.isArray(host.Binds) || host.Binds.length !== 0)) ||
    Object.keys(tmpfs).sort().join() !== "/data,/fixture" ||
    ["/data", "/fixture"].some((path) => tmpfs[path] !== "rw,noexec,nosuid,size=32m,uid=65534,gid=65534,mode=0700") ||
    log.Type !== "json-file" ||
    limits["max-size"] !== "1m" || limits["max-file"] !== "1"
  ) throw new Error("Vercel effective engine limits differ.");
  if (!running) {
    if (state.ExitCode !== 0) throw new Error("Vercel emulator did not retire cleanly.");
    console.log(JSON.stringify({ vercelRetirement: { running: false, oomKilled: false, exitCode: state.ExitCode } }));
    return;
  }
  const mounts = execFileSync("docker", ["exec", id, "/bin/cat", "/proc/self/mountinfo"], {
    encoding: "utf8",
    timeout: 10000,
    maxBuffer: 131072,
  });
  for (const path of ["/data", "/fixture"]) {
    const rows = mounts.split("\n").map((line) => line.split(" ")).filter((fields) => fields[4] === path);
    if (rows.length !== 1) throw new Error("Vercel effective tmpfs missing or duplicated: " + path);
    const row = rows[0]!,
      separator = row.indexOf("-"),
      flags = new Set((row[5] ?? "").split(",")),
      superFlags = new Set((row[separator + 3] ?? "").split(","));
    if (
      separator < 6 || row[separator + 1] !== "tmpfs" || !flags.has("rw") || !flags.has("nosuid") ||
      !flags.has("noexec") || !["size=32768k", "size=33554432", "size=32m"].some((size) => superFlags.has(size))
    ) throw new Error("Vercel effective tmpfs flags/extent differ: " + path);
  }
  console.log(
    JSON.stringify({
      vercelIsolation: {
        image: VERCEL_IMAGE,
        network: "none",
        uid: "65534:65534",
        memoryBytes: host.Memory,
        readonlyRootfs: host.ReadonlyRootfs,
        swapBytes: host.MemorySwap,
        pids: host.PidsLimit,
        tmpfsBytes: 33554432,
        fixtureTmpfsBytes: 33554432,
        mountinfoSha256: hash(Buffer.from(mounts)),
      },
    }),
  );
}

/** One fixed oracle invocation and idempotent cleanup; no arbitrary command or downloaded CLI can be selected. */
export class VercelFixture implements AsyncDisposable {
  readonly #container: StartedTestContainer;
  readonly #release: () => Promise<void>;
  #closing: Promise<void> | undefined;
  #observed = false;
  constructor(container: StartedTestContainer, release: () => Promise<void>) {
    this.#container = container;
    this.#release = release;
  }
  close(): Promise<void> {
    return this.#closing ??= this.#release();
  }
  [Symbol.asyncDispose](): Promise<void> {
    return this.close();
  }
  async observe(): Promise<Record<string, unknown>> {
    if (this.#closing || this.#observed) {
      throw new Error("Vercel fixed oracle is single-use and requires a live fixture.");
    }
    this.#observed = true;
    try {
      const raw = execFileSync("docker", [
        "exec",
        "-e",
        "VERCEL_BLOB_API_URL=http://127.0.0.1:8071/api/blob",
        "-e",
        "VERCEL_BLOB_RETRIES=0",
        this.#container.getId(),
        "timeout",
        "--signal=KILL",
        "30s",
        "node",
        "--max-old-space-size=128",
        "/fixture/sdk/oracle.ts",
      ], { encoding: "utf8", timeout: 45000, maxBuffer: 2 * 1048576, killSignal: "SIGKILL" });
      const receipts = raw.split(/\r?\n/u).filter((line) => line.startsWith("RECEIPT:"));
      if (receipts.length !== 1) throw new Error("Vercel native receipt absent or duplicated.");
      return object(JSON.parse(receipts[0]!.slice(8)));
    } catch (reason) {
      await close([() => this.close()], [reason]);
      throw reason;
    }
  }
}

/** Start the public emulator only after copying exact hash-admitted files; retire partially created containers too. */
export async function openVercel(admission: VercelAdmissionType): Promise<VercelFixture> {
  const contents = [...copies(admission), {
    content: VERCEL_SERVER,
    target: "/fixture/emulator/server.ts",
    mode: 0o444,
  }, { content: VERCEL_ORACLE, target: "/fixture/sdk/oracle.ts", mode: 0o444 }];
  let copiedBytes = 0;
  for (const item of contents) {
    copiedBytes += typeof item.content === "string" ? Buffer.byteLength(item.content) : item.content.byteLength;
    if (copiedBytes > 24 * 1048576) {
      throw new Error("Vercel complete fixture copy exceeds its 24 MiB admission ceiling.");
    }
  }
  const { GenericContainer, Wait, getContainerRuntimeClient } = await import("testcontainers");
  const runtime = await getContainerRuntimeClient(), releases: (() => Promise<unknown>)[] = [];
  const release = (): Promise<void> => close([...releases].reverse());
  const startup: Buffer[] = [];
  let logBytes = 0;
  class OwnedContainer extends GenericContainer {
    constructor() {
      super(VERCEL_IMAGE);
      this.hostConfig.MemorySwap = 1073741824;
      this.hostConfig.ReadonlyRootfs = true;
      this.hostConfig.PidsLimit = 256;
      this.hostConfig.LogConfig = { Type: "json-file", Config: { "max-size": "1m", "max-file": "1" } };
    }
    protected override containerCreated(id: string): Promise<void> {
      releases.push(async () => {
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
    const container = await new OwnedContainer().withLabels({ "opfs.fixture": randomUUID() }).withNetworkMode("none")
      .withUser("65534:65534")
      .withDroppedCapabilities("ALL").withSecurityOpt("no-new-privileges")
      .withTmpFs({
        "/data": "rw,noexec,nosuid,size=32m,uid=65534,gid=65534,mode=0700",
        "/fixture": "rw,noexec,nosuid,size=32m,uid=65534,gid=65534,mode=0700",
      })
      .withEntrypoint(["sh"]).withCommand([
        "-c",
        "trap 'exit 0' TERM INT; remaining=120; until test -f /fixture/ready; do if test \"$remaining\" -le 0; then exit 70; fi; remaining=$((remaining - 1)); sleep 1 & wait $!; done; exec node --max-old-space-size=128 /fixture/emulator/server.ts",
      ])
      .withResourcesQuota({ memory: 1, cpu: 1 }).withLogConsumer((stream) => {
        stream.on("data", (chunk: unknown) => {
          if (logBytes >= 65536) return;
          const bytes = (chunk instanceof Uint8Array ? Buffer.from(chunk) : Buffer.from(String(chunk))).subarray(
            0,
            65536 - logBytes,
          );
          startup.push(Buffer.from(bytes));
          logBytes += bytes.length;
        });
      })
      .withWaitStrategy(Wait.forSuccessfulCommand("true")).withStartupTimeout(60000).start();
    releases.push(async () => {
      await container.stop({ remove: false, timeout: 5000 });
      inspect(container.getId(), false);
    });
    inspect(container.getId(), true);
    // Built-in-only writer validates every entry before writes and publishes ready only after hash readback.
    copy(contents, container.getId());
    const started = await container.exec([
      "timeout",
      "--signal=KILL",
      "60s",
      "sh",
      "-c",
      "while ! test -s /data/address; do sleep 0.1; done",
    ]);
    if (started.exitCode !== 0) {
      throw new Error("Vercel emulator did not publish readiness within its startup allowance.");
    }
    return new VercelFixture(container, release);
  } catch (reason) {
    console.error("Vercel startup diagnostics (bounded, fixture-only):", Buffer.concat(startup).toString());
    await close([release], [reason]);
    throw reason;
  }
}
