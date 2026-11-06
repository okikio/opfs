import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { execFileSync } from "node:child_process";
import { arch } from "node:process";
import { close } from "../../src/close.ts";
import { collectBytes } from "../../src/stream.ts";
import { readResponse } from "../../src/response.ts";
import { sourceRange } from "../../src/source.ts";
import { openTar } from "../../src/archive/tar.ts";
import type { StartedTestContainer } from "testcontainers";

/** Existing pinned Node image supplies only native libc/shell/timeout; no npm modules, SDK resolver or compilation runs. */
export const ETCD_IMAGE =
  "node:22.22.0-bookworm-slim@sha256:dd9d21971ec4395903fa6143c2b9267d048ae01ca6d3ea96f16cb30df6187d94";
const ARTIFACTS = {
  arm64: { size: 21917428, sha256: "ce4c08f5f43d99f0d1993552ce2906829c0366077a97e5e52529337f151a29fb" },
  amd64: { size: 23941525, sha256: "5dfa9cc3b3ce3b4b491fbcc2057d3daa166bcc6676f743fcd20f8e5760cb9775" },
} as const;
type ArchitectureType = keyof typeof ARTIFACTS;
interface EtcdArtifactType {
  readonly architecture: ArchitectureType;
  readonly files: Readonly<Record<string, Buffer>>;
  readonly manifest: {
    readonly archiveSha256: string;
    readonly expandedBytes: number;
    readonly entries: readonly { readonly name: string; readonly kind: string; readonly size: number }[];
    readonly selected: readonly { readonly name: string; readonly size: number; readonly sha256: string }[];
  };
}
/** Inert acquisition only: exact official release URL, no credentials, at most2 HTTPS redirect hops to its exact CDN origin. */
export async function acquireEtcd(architecture: ArchitectureType): Promise<EtcdArtifactType> {
  const pin = ARTIFACTS[architecture];
  let url = new URL(
    `https://github.com/etcd-io/etcd/releases/download/v3.7.3/etcd-v3.7.3-linux-${architecture}.tar.gz`,
  );
  const signal = AbortSignal.timeout(90_000);
  let compressed: Uint8Array | undefined;
  for (let hop = 0; hop < 3; hop++) {
    const response = await fetch(url, {
      redirect: "manual",
      credentials: "omit",
      referrerPolicy: "no-referrer",
      signal,
    });
    if (response.status === 302 || response.status === 301 || response.status === 307 || response.status === 308) {
      const location = response.headers.get("location");
      await readResponse(response, () => {
        if (location === null) throw new Error("etcd artifact redirect has no target.");
      });
      if (hop === 2) throw new Error("etcd artifact redirect exceeds policy.");
      let target: URL;
      try {
        target = new URL(location!, url);
      } catch {
        throw new Error("etcd artifact redirect is invalid.");
      }
      if (
        target.origin !== "https://release-assets.githubusercontent.com" || target.username || target.password ||
        target.hash
      ) throw new Error("etcd artifact redirect is not granted.");
      url = target;
      continue;
    }
    if (response.status !== 200 || response.body === null) {
      return await readResponse(response, () => {
        throw new Error("etcd official artifact acquisition failed.");
      });
    }
    compressed = await collectBytes(response.body, 32 * 1024 * 1024, signal, "read", "etcd test artifact");
    break;
  }
  if (
    compressed === undefined || compressed.length !== pin.size ||
    createHash("sha256").update(compressed).digest("hex") !== pin.sha256
  ) throw new Error("etcd official archive differs from its release digest.");
  // Native gzip validates its footer and bounds the expansion before the TAR scanner sees any bytes.
  const decoded = new Uint8Array(gunzipSync(compressed, { maxOutputLength: 256 * 1024 * 1024 }));
  const archive = await openTar({
    size: decoded.length,
    stability: "immutable",
    read: async (offset, length) => {
      sourceRange(decoded.length, offset, length);
      return decoded.slice(offset, offset + length);
    },
  }, {
    maxEntries: 1000,
    maxMetadataBytes: 1024 * 1024,
    maxSourceBytes: 512 * 1024 * 1024,
    maxDecodedBytes: 256 * 1024 * 1024,
    maxOutputBytes: 192 * 1024 * 1024,
    maxRequests: 5000,
  });
  const prefix = `etcd-v3.7.3-linux-${architecture}`;
  const entries: { name: string; kind: string; size: number }[] = [], seen = new Set<string>();
  let total = 0;
  for (const entry of archive.entries) {
    const name = entry.name.endsWith("/") ? entry.name.slice(0, -1) : entry.name;
    if (
      name.length > 4096 || name.includes("\\") || name.startsWith("/") || [...name].some((c) =>
        c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127
      ) || name.split("/").some((p) => p === "" || p === "." || p === "..") ||
      !(name === prefix || name.startsWith(prefix + "/")) || seen.has(name) ||
      entry.kind !== "file" && entry.kind !== "directory" || entry.sparse !== undefined || entry.link !== "" ||
      entry.kind === "directory" && entry.size !== 0
    ) throw new Error("etcd archive has an unsupported member/path/link.");
    seen.add(name);
    total += entry.size;
    if (total > 256 * 1024 * 1024) throw new Error("etcd archive declared expansion exceeds policy.");
    entries.push({ name, kind: entry.kind, size: entry.size });
  }
  const files: Record<string, Buffer> = Object.create(null),
    selected: { name: string; size: number; sha256: string }[] = [];
  // No host path extraction occurs. Only these exact regular members become inert copied byte buffers.
  for (const name of ["etcd", "etcdctl", "LICENSE", "NOTICE"]) {
    const matches = archive.entries.filter((entry) => entry.name === `${prefix}/${name}`);
    if (matches.length === 0 && (name === "LICENSE" || name === "NOTICE")) continue;
    if (matches.length !== 1 || matches[0]!.kind !== "file" || matches[0]!.size > 96 * 1024 * 1024) {
      throw new Error("etcd archive omits a bounded selected regular member.");
    }
    const bytes = (await archive.read(matches[0]!.id, {
      maxSourceBytes: 96 * 1024 * 1024,
      maxDecodedBytes: 96 * 1024 * 1024,
      maxOutputBytes: 96 * 1024 * 1024,
      maxRequests: 1,
    })).bytes;
    files[name] = Buffer.from(bytes);
    selected.push({ name, size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });
  }
  return {
    architecture,
    files,
    manifest: { archiveSha256: pin.sha256, expandedBytes: decoded.length, entries, selected },
  };
}
/** Native server command. It binds only fixture ports, one member, a64MiB database quota and an explicit1.5MiB native request limit. */
export const ETCD_COMMAND = [
  "/oracle/etcd",
  "--name=fixture",
  "--data-dir=/data",
  "--listen-client-urls=http://0.0.0.0:2379",
  "--advertise-client-urls=http://etcd.test:2379",
  "--listen-peer-urls=http://127.0.0.1:2380",
  "--initial-advertise-peer-urls=http://127.0.0.1:2380",
  "--initial-cluster=fixture=http://127.0.0.1:2380",
  "--quota-backend-bytes=67108864",
  "--max-request-bytes=1572864",
  "--enable-grpc-gateway=true",
] as const;
/** One native server and its official independent gRPC CLI, with explicit disposable authentication and no production SDK. */
export class EtcdFixture implements AsyncDisposable {
  readonly endpoint: string;
  readonly #server: StartedTestContainer;
  readonly #resources: readonly (() => Promise<unknown>)[];
  #closure: Promise<void> | undefined;
  #token: string | undefined;
  constructor(server: StartedTestContainer, resources: readonly (() => Promise<unknown>)[]) {
    this.#server = server;
    this.#resources = [...resources];
    this.endpoint = `http://${server.getHost()}:${server.getMappedPort(2379)}/`;
  }
  get token(): string {
    if (this.#token === undefined) throw new Error("etcd fixture authentication is not initialized.");
    return this.#token;
  }
  async command(args: string[], authenticated = true): Promise<string> {
    const result = await this.#server.exec([
      "timeout",
      "20",
      "/oracle/etcdctl",
      "--endpoints=http://127.0.0.1:2379",
      "--dial-timeout=5s",
      "--command-timeout=10s",
      ...(authenticated ? ["--user=root:disposable-only"] : []),
      ...args,
    ]);
    if (result.exitCode !== 0 || result.output.length > 2 * 1024 * 1024) {
      throw new Error(`Native etcdctl fixture command failed: ${result.output.slice(0, 8192)}`);
    }
    return result.output;
  }
  /** Root auth setup is explicit fixture-only administration, absent from the production client. */
  async init(): Promise<void> {
    const version = await this.command(["version"], false);
    if (!/^etcdctl version: 3\.7\.3$/mu.test(version)) throw new Error("Independent etcdctl version mismatch.");
    await this.command(["user", "add", "root", "--new-user-password=disposable-only"], false);
    await this.command(["user", "grant-role", "root", "root"], false);
    await this.command(["auth", "enable"], false);
    const response = await fetch(new URL("v3/auth/authenticate", this.endpoint), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "root", password: "disposable-only" }),
      redirect: "error",
      credentials: "omit",
      signal: AbortSignal.timeout(10_000),
    });
    this.#token = await readResponse(response, async (body) => {
      if (response.status !== 200) throw new Error("Native etcd authentication failed.");
      const data: unknown = JSON.parse(await body());
      if (
        data === null || typeof data !== "object" || !("token" in data) || typeof data.token !== "string" ||
        !data.token.length || data.token.length > 8192
      ) throw new Error("Native etcd token missing.");
      return data.token;
    });
  }
  /** A copied bounded file feeds CLI stdin verbatim; keys are independent argv, never interpolated shell code. */
  async seed(name: string, bytes: Uint8Array, leaseHex?: string): Promise<void> {
    if (
      bytes.length > 1024 * 1024 || name.length > 4096 || name.includes("\0") ||
      leaseHex !== undefined && !/^[0-9a-f]{1,16}$/u.test(leaseHex)
    ) throw new Error("etcd seed exceeds fixture policy.");
    const owned = Buffer.from(bytes);
    await this.#server.copyContentToContainer([{ content: owned, target: "/oracle/input.bin" }]);
    const result = await this.#server.exec([
      "timeout",
      "20",
      "sh",
      "-c",
      'exec /oracle/etcdctl --endpoints=http://127.0.0.1:2379 --dial-timeout=5s --command-timeout=10s --user=root:disposable-only put --lease="$2" -- "$1" < /oracle/input.bin',
      "fixture-stdin",
      name,
      leaseHex ?? "0",
    ]);
    if (result.exitCode !== 0) throw new Error(`Independent etcdctl seed failed: ${result.output.slice(0, 8192)}`);
  }
  async read(name: string): Promise<Uint8Array<ArrayBuffer>> {
    const output = await this.command(["get", "--write-out=json", "--", name]);
    // Only native base64 strings are consumed here; unsafe bare numeric CLI header fields are intentionally not interpreted.
    const data: unknown = JSON.parse(output);
    if (
      data === null || typeof data !== "object" || !("kvs" in data) || !Array.isArray(data.kvs) || data.kvs.length !== 1
    ) throw new Error("Independent etcdctl omitted exact-key bytes.");
    const row: unknown = data.kvs[0];
    if (
      row === null || typeof row !== "object" || !("key" in row) || typeof row.key !== "string" ||
      Buffer.from(row.key, "base64").toString("utf8") !== name
    ) throw new Error("Independent etcdctl returned another key.");
    const value = "value" in row ? row.value : "";
    if (typeof value !== "string" || value.length > 1400000) {
      throw new Error("Independent etcdctl returned invalid bytes.");
    }
    return new Uint8Array(Buffer.from(value, "base64"));
  }
  close(): Promise<void> {
    return this.#closure ??= close([...this.#resources].reverse());
  }
  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }
}
/** Full recipe requires review before acquisition or execution; copied buffers are the only artifact extraction. */
export async function openEtcd(
  architecture: ArchitectureType = arch === "arm64" ? "arm64" : "amd64",
): Promise<EtcdFixture> {
  const acquired = await acquireEtcd(architecture);
  const { GenericContainer, Network, Wait } = await import("testcontainers");
  const resources: (() => Promise<unknown>)[] = [];
  let nativeId: string | undefined;
  class NativeContainer extends GenericContainer {
    protected override containerCreated(id: string): Promise<void> {
      nativeId = id;
      return Promise.resolve();
    }
  }
  try {
    const network = await new Network().start();
    resources.push(() => network.stop());
    const server = await new NativeContainer(ETCD_IMAGE).withPlatform(`linux/${architecture}`).withNetwork(network)
      .withNetworkAliases("etcd.test")
      .withCopyContentToContainer(
        Object.entries(acquired.files).map(([name, content]) => ({
          content,
          target: `/oracle/${name}`,
          mode: name === "etcd" || name === "etcdctl" ? 0o755 : 0o644,
        })),
      )
      .withCommand([...ETCD_COMMAND]).withExposedPorts(2379).withResourcesQuota({ memory: 1, cpu: 1 })
      .withWaitStrategy(Wait.forHttp("/health", 2379, { abortOnContainerExit: true }).forStatusCode(200))
      .withStartupTimeout(60_000).start();
    resources.push(() => server.stop());
    const fixture = new EtcdFixture(server, resources);
    await fixture.init();
    return fixture;
  } catch (reason) {
    if (nativeId !== undefined) {
      try {
        console.error(
          "etcd bootstrap:",
          execFileSync("docker", ["logs", nativeId], { encoding: "utf8", timeout: 10_000, maxBuffer: 1024 * 1024 }),
        );
      } catch (diagnostic) {
        console.error("etcd bootstrap diagnostics unavailable:", diagnostic);
      }
    }
    await close(resources.reverse(), [reason]);
    throw reason;
  }
}
