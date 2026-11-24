/** Test-only official Netlify SDK/server and separately admitted candidate fixture. @module */
import { Buffer } from "node:buffer";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { StartedTestContainer } from "testcontainers";
import { close } from "../close.ts";

/** The existing reviewed multi-architecture Node26 fixture base; execution still needs explicit closure admission. */
export const NETLIFY_IMAGE =
  "node:26.13.0-bookworm-slim@sha256:add5c17c14752c54d2f3d519ec46a3815684d41c33f198bcb09fb998f7dcbf68";
/** Execution authority names the exact inert closure that the fixture owner reviewed, including its legal material. */
export interface NetlifyAdmissionType {
  readonly directory: string;
  readonly closureSha256: string;
  readonly reviewedForTestExecution: true;
  /** Separately built standalone candidate; its complete bytes are checked before container materialization. */
  readonly candidate?: { readonly file: string; readonly sha256: string };
}
interface ContentType {
  readonly content: Buffer<ArrayBuffer> | string;
  readonly target: string;
  readonly mode: number;
}
function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Expected Netlify evidence object.");
  }
  return value as Record<string, unknown>;
}
/** Docker Engine uses null or an empty JSON object for no published ports; missing evidence is not admission. */
export function hasNoPublishedPorts(value: unknown): boolean {
  if (value === null) return true;
  if (typeof value !== "object" || Array.isArray(value)) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return (prototype === Object.prototype || prototype === null) && Reflect.ownKeys(value).length === 0;
}
function hash(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
/** Read exact regular snapshots; neither symlinks nor a claimed size authorize an unbounded read. */
function read(path: string, maximum: number): Buffer<ArrayBuffer> {
  const info = lstatSync(path);
  if (!info.isFile() || info.size > maximum) throw new Error("Netlify evidence is not a bounded regular file.");
  const bytes = readFileSync(path);
  if (bytes.length !== info.size) throw new Error("Netlify evidence size changed during admission.");
  return bytes;
}
/** Read effective engine and kernel isolation instead of treating requested quotas as proof. */
function inspect(container: string, running: boolean): void {
  const raw = execFileSync("docker", ["inspect", container], { encoding: "utf8", timeout: 10000, maxBuffer: 131072 });
  const values: unknown = JSON.parse(raw);
  if (!Array.isArray(values) || values.length !== 1) throw new Error("Netlify engine inspection differs.");
  const value = object(values[0]),
    host = object(value.HostConfig),
    config = object(value.Config),
    state = object(value.State);
  const tmpfs = object(host.Tmpfs), log = object(host.LogConfig), limits = object(log.Config);
  if (
    config.Image !== NETLIFY_IMAGE || config.User !== "65534:65534" || state.Running !== running ||
    state.OOMKilled !== false ||
    host.Memory !== 1073741824 || host.MemorySwap !== 1073741824 || host.NanoCpus !== 1000000000 ||
    host.PidsLimit !== 256 || host.NetworkMode !== "none" || host.Privileged !== false ||
    host.PublishAllPorts !== false ||
    !Array.isArray(host.CapDrop) || !host.CapDrop.includes("ALL") ||
    !Array.isArray(host.SecurityOpt) || !host.SecurityOpt.includes("no-new-privileges") ||
    (host.CapAdd !== null && (!Array.isArray(host.CapAdd) || host.CapAdd.length !== 0)) ||
    (host.Binds !== null && (!Array.isArray(host.Binds) || host.Binds.length !== 0)) ||
    !hasNoPublishedPorts(host.PortBindings) || Object.keys(tmpfs).join() !== "/data" ||
    tmpfs["/data"] !== "rw,noexec,nosuid,size=32m,uid=65534,gid=65534,mode=0700" ||
    log.Type !== "json-file" || limits["max-size"] !== "1m" || limits["max-file"] !== "1"
  ) {
    throw new Error("Actual Netlify fixture resource or isolation limits differ from the recipe.");
  }
  if (!running) {
    if (state.ExitCode !== 0) throw new Error("Netlify server did not retire cleanly within its stop allowance.");
    console.log(JSON.stringify({ netlifyRetirement: { running: false, oomKilled: false, exitCode: state.ExitCode } }));
    return;
  }
  const mounts = execFileSync("docker", ["exec", container, "/bin/cat", "/proc/self/mountinfo"], {
    encoding: "utf8",
    timeout: 10000,
    maxBuffer: 131072,
  });
  const matches = mounts.split("\n").map((line) => line.split(" ")).filter((fields) => fields[4] === "/data");
  if (matches.length !== 1) throw new Error("Netlify effective data mount is absent or duplicated.");
  const fields = matches[0]!, separator = fields.indexOf("-"), flags = new Set((fields[5] ?? "").split(","));
  const superFlags = new Set((fields[separator + 3] ?? "").split(","));
  if (
    separator < 6 || fields[separator + 1] !== "tmpfs" || !flags.has("rw") || !flags.has("nosuid") ||
    !flags.has("noexec") ||
    !["size=32768k", "size=33554432", "size=32m"].some((size) => superFlags.has(size))
  ) {
    throw new Error("Netlify effective tmpfs type, flags or byte ceiling differs.");
  }
  console.log(
    JSON.stringify({
      netlifyIsolation: {
        image: NETLIFY_IMAGE,
        network: "none",
        uid: "65534:65534",
        memoryBytes: host.Memory,
        swapBytes: host.MemorySwap,
        pids: host.PidsLimit,
        tmpfsBytes: 33554432,
        mountinfoSha256: hash(Buffer.from(mounts)),
      },
    }),
  );
}
/** Materialization is a copy of hash-admitted files; no package manager, lifecycle hook or private entrypoint is invoked. */
function copies(admission: NetlifyAdmissionType): ContentType[] {
  if (admission.reviewedForTestExecution !== true || !/^[0-9a-f]{64}$/.test(admission.closureSha256)) {
    throw new Error("Explicit reviewed Netlify closure identity is required before execution.");
  }
  const root = resolve(admission.directory), raw = read(join(root, "closure.json"), 4 * 1048576);
  if (hash(raw) !== admission.closureSha256) {
    throw new Error("Netlify closure identity differs from execution admission.");
  }
  const closure = object(JSON.parse(raw.toString("utf8")));
  if (closure.root !== "@netlify/blobs@11.1.7" || !Array.isArray(closure.packages) || closure.packages.length !== 46) {
    throw new Error("Wrong Netlify public SDK closure.");
  }
  const output: ContentType[] = [], names = new Set<string>();
  let bytes = 0, files = 0;
  for (const rawPackage of closure.packages) {
    const item = object(rawPackage);
    if (
      typeof item.id !== "string" || !/^(@[a-z0-9._-]+\/[a-z0-9._-]+|[a-z0-9._-]+)@[0-9][a-zA-Z0-9.+_-]*$/.test(item.id)
    ) throw new Error("Invalid admitted package identity.");
    const split = item.id.lastIndexOf("@"), name = item.id.slice(0, split), version = item.id.slice(split + 1);
    if (names.has(name)) throw new Error("Netlify flattened closure has duplicate package names.");
    names.add(name);
    if (!Array.isArray(item.members)) throw new Error("Netlify package members are absent.");
    const paths = new Set<string>();
    for (const rawMember of item.members) {
      const member = object(rawMember), path = member.path;
      if (
        typeof path !== "string" || path.length > 1024 || path.includes("\\") || path.split("/").some((part) =>
          !part || part === "." || part === ".."
        ) || path.startsWith("/") || paths.has(path)
      ) throw new Error("Unsafe or duplicate Netlify member path.");
      paths.add(path);
      if (
        typeof member.bytes !== "number" || !Number.isSafeInteger(member.bytes) || member.bytes < 0 ||
        member.bytes > 8 * 1048576 || typeof member.sha256 !== "string"
      ) throw new Error("Invalid Netlify member size/hash.");
      if (++files > 12000 || member.bytes > 96 * 1048576 - bytes) {
        throw new Error("Netlify materialization exceeds its aggregate allowance.");
      }
      bytes += member.bytes;
      const content = read(
        join(root, "source", name.replace("/", "__") + "@" + version, path + ".snapshot"),
        member.bytes,
      );
      if (content.length !== member.bytes || hash(content) !== member.sha256) {
        throw new Error("Netlify materialized bytes differ from admitted evidence.");
      }
      output.push({ content, target: "/fixture/node_modules/" + name + "/" + path, mode: 0o444 });
    }
  }
  if (admission.candidate !== undefined) {
    if (!/^[0-9a-f]{64}$/.test(admission.candidate.sha256)) throw new Error("Candidate SHA-256 is required.");
    const candidate = read(resolve(admission.candidate.file), 4 * 1048576);
    if (candidate.length === 0 || hash(candidate) !== admission.candidate.sha256) {
      throw new Error("Netlify candidate bytes differ from separate execution admission.");
    }
    output.push({ content: candidate, target: "/fixture/candidate.ts", mode: 0o444 });
  }
  return output;
}
/** Public SDK imports run only after owner admission and inside the private container. */
const SERVER = String.raw`
import process from "node:process";
import { appendFileSync, writeFileSync } from "node:fs";
import { BlobsServer } from "@netlify/blobs/server";
let listObservations = 0;
writeFileSync("/data/list-observations", "", { flag: "wx", mode: 0o600 });
const server = new BlobsServer({ directory: "/data/blobs", port: 8071, token: "fixture-only-netlify", logger() {},
  onRequest({ type, url }) {
    if (type !== "list") return;
    if (++listObservations > 16) throw new Error("Native list observation allowance exceeded.");
    const parsed = new URL(url, "http://fixture.invalid"), prefix = parsed.searchParams.get("prefix");
    // The public callback exposes a signed query: persist only authored comparisons, never its value.
    appendFileSync("/data/list-observations", JSON.stringify({ path: parsed.pathname, noPrefix: prefix === null,
      authoredPrefix: prefix === "roundtrip-", prefixHasSignatureSuffix: prefix?.startsWith("roundtrip-?signature=") ?? false }) + "\n");
  }
});
const { address } = await server.start();
writeFileSync("/data/server-address", address, { flag: "wx", mode: 0o600 });
process.once("SIGTERM", () => {
  const deadline = setTimeout(() => process.exit(1), 5000); deadline.unref();
  void server.stop().then(() => process.exit(0), () => process.exit(1));
});
console.log("OPFS NETLIFY SDK SERVER READY");
`;
/**
 * SDK-to-SDK observations establish only the pinned local implementation. Paths
 * and condition/auth presence are retained; signed queries and tokens are never
 * printed. The lost-reply control deliberately leaves SDK retry policy intact.
 */
const ORACLE = String.raw`
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import process from "node:process";
import { readFileSync, statSync } from "node:fs";
import { getStore } from "@netlify/blobs";
// Native SDK error text may contain capability URLs. A failed oracle emits only a fixed diagnostic.
process.once("uncaughtException", () => { console.error("Netlify official oracle failed; secret-bearing SDK error text withheld."); process.exit(1); });
const endpoint = new URL(readFileSync("/data/server-address", "utf8"));
if (endpoint.protocol !== "http:" || endpoint.port !== "8071" || !["localhost", "127.0.0.1", "0.0.0.0", "[::1]", "[::]"].includes(endpoint.hostname)) throw new Error("Unexpected native local server address.");
interface RequestObservationType {
  method: string; path: string; api: boolean; capability: boolean; authorization: boolean;
  negotiation: boolean; ifMatch: boolean; ifNoneMatch: string | null;
  externalMetadata: boolean; internalMetadata: boolean; payloadBytes: number; payloadSha256: string;
  responseStatus: number | null; responseInternalMetadata: boolean;
}
const requests: RequestObservationType[] = [];
let lost = false, uncertainAttempts = 0;
const transport: typeof fetch = async (input, init) => {
  const request = new Request(input, init), url = new URL(request.url);
  if (url.origin !== endpoint.origin) throw new Error("Official SDK escaped fixture authority.");
  if (requests.length >= 128) throw new Error("SDK request count exceeded fixture policy.");
  // Inspect an owned clone before dispatch. Only lengths/hashes and safe header presence enter the receipt.
  const body = request.clone().body, reader = body?.getReader(), payload = createHash("sha256");
  let payloadBytes = 0;
  if (reader) {
    try {
      for (;;) {
        const item = await reader.read();
        if (item.done) break;
        payloadBytes += item.value.length;
        if (payloadBytes > 131072) throw new Error("Authored SDK request payload exceeds fixture ceiling.");
        payload.update(item.value);
      }
    } catch (reason) {
      // Both tee branches must be cancelled together; awaiting only the clone could wait for the unsent request.
      const settled = await Promise.allSettled([reader.cancel(reason), request.body?.cancel(reason)]);
      const faults: unknown[] = [reason];
      for (const result of settled) if (result.status === "rejected") faults.push(result.reason);
      throw new AggregateError(faults, "Authored SDK request trace/retirement failed.");
    } finally { reader.releaseLock(); }
  }
  const observation: RequestObservationType = {
    method: request.method, path: url.pathname, api: url.pathname.startsWith("/api/v1/"),
    capability: url.searchParams.has("signature"), authorization: request.headers.has("authorization"),
    negotiation: request.headers.get("accept") === "application/json;type=signed-url",
    ifMatch: request.headers.has("if-match"), ifNoneMatch: request.headers.get("if-none-match"),
    externalMetadata: request.headers.has("netlify-blobs-metadata"), internalMetadata: request.headers.has("x-amz-meta-user"),
    payloadBytes, payloadSha256: payload.digest("hex"), responseStatus: null, responseInternalMetadata: false,
  };
  requests.push(observation);
  const response = await fetch(request);
  observation.responseStatus = response.status;
  observation.responseInternalMetadata = response.headers.has("x-amz-meta-user");
  if (request.method === "PUT" && url.pathname.endsWith("/uncertain") && !url.pathname.startsWith("/api/v1/")) {
    uncertainAttempts++;
    if (!lost && response.status === 200) { lost = true; await response.body?.cancel(); throw new Error("Authored lost PUT acknowledgement after publication."); }
  }
  return response;
};
const options = { name: "fixture", siteID: "fixture-site", token: "fixture-only-netlify", apiURL: endpoint.origin, fetch: transport };
const store = getStore(options);
const originals = [new Uint8Array(), Uint8Array.from({ length: 131072 }, (_, i) => (i * 31 + (i >>> 8)) & 255)];
const authoredMetadata = { origin: "authored", label: "café / 雪 / ☁️", "κλειδί": { present: true, empty: "" } };
const roundtrips: Array<{ receipt: { etag?: string; modified: boolean }; bytes: string; metadata: unknown; dataMetadata: unknown; headEtag: string | null }> = [];
for (const [index, bytes] of originals.entries()) {
  const key = "roundtrip-" + index;
  const receipt = await store.set(key, bytes.buffer, { metadata: authoredMetadata, onlyIfNew: true });
  const returned = await store.getWithMetadata(key, { type: "arrayBuffer" });
  if (!returned || !(returned.data instanceof ArrayBuffer)) throw new Error("SDK get did not return complete bytes.");
  const observed = await store.getMetadata(key);
  roundtrips.push({ receipt, bytes: Buffer.from(returned.data).toString("base64"), metadata: observed?.metadata, dataMetadata: returned.metadata, headEtag: observed?.etag ?? null });
}
const refused = await store.set("roundtrip-1", new Uint8Array([9]).buffer, { onlyIfNew: true });
const stale = await store.set("roundtrip-1", new Uint8Array([8]).buffer, { onlyIfMatch: '"not-the-current-etag"' });
const afterRefusals = Buffer.from(await store.get("roundtrip-1", { type: "arrayBuffer" })).toString("base64");
const currentEtag = roundtrips[1]!.receipt.etag;
if (typeof currentEtag !== "string" || currentEtag.length === 0) throw new Error("Native PUT receipt did not carry an ETag.");
const matched = await store.set("roundtrip-1", new Uint8Array([1, 2, 3]).buffer, { metadata: { origin: "matched" }, onlyIfMatch: currentEtag });
const afterMatched = Buffer.from(await store.get("roundtrip-1", { type: "arrayBuffer" })).toString("base64");
const cached = await store.getWithMetadata("roundtrip-1", { type: "arrayBuffer", etag: matched.etag });
const pages: unknown[] = [];
for await (const page of store.list({ prefix: "roundtrip-", paginate: true })) {
  if (pages.length >= 4) throw new Error("Native list exceeded fixture page allowance.");
  pages.push(page);
}
const unfilteredPages: unknown[] = [];
for await (const page of store.list({ paginate: true })) {
  if (unfilteredPages.length >= 4) throw new Error("Native unfiltered list exceeded fixture page allowance.");
  unfilteredPages.push(page);
}
if (statSync("/data/list-observations").size > 32768) throw new Error("Native list observations exceed byte allowance.");
const listObservations = readFileSync("/data/list-observations", "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as unknown);
const stream = await store.get("roundtrip-1", { type: "stream" });
await stream.cancel("fixture stops consuming owned response");
await store.delete("roundtrip-0"); await store.delete("roundtrip-0");
const absent = await store.get("roundtrip-0", { type: "arrayBuffer" });
let wrongTokenRejected = false;
try { await getStore({ ...options, token: "wrong-fixture-token" }).get("roundtrip-1", { type: "arrayBuffer" }); } catch { wrongTokenRejected = true; }
const uncertain = await store.set("uncertain", new Uint8Array([7, 0, 255]).buffer, { onlyIfNew: true, metadata: { origin: "lost-reply" } });
const publishedAfterFalse = Buffer.from(await store.get("uncertain", { type: "arrayBuffer" })).toString("base64");
console.log("RECEIPT:" + JSON.stringify({ profile: "netlify-blobs-11.1.7-local-sdk-observations-v1", candidate: false, roundtrips, refused, stale, afterRefusals, matched, afterMatched, cache: { etag: cached?.etag ?? null, hasData: cached?.data instanceof ArrayBuffer }, pages, unfilteredPages, listObservations, absent, wrongTokenRejected, uncertain, uncertainAttempts, publishedAfterFalse, streamCanceled: true, requests }));
`;

/** Reciprocal full-byte checks against public SDK APIs; neither side supplies the other's expectations. */
const CANDIDATE = String.raw`
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import process from "node:process";
import { getStore } from "@netlify/blobs";
import { createNetlifyClient, NETLIFY_PROFILE, NetlifyError, NetlifyPublicationError } from "./candidate.ts";
process.once("uncaughtException", () => { console.error("Netlify reciprocal oracle failed; secret-bearing error text withheld."); process.exit(1); });
const endpoint = new URL(readFileSync("/data/server-address", "utf8"));
if (endpoint.protocol !== "http:" || endpoint.port !== "8071" || !["localhost", "127.0.0.1", "0.0.0.0", "[::1]", "[::]"].includes(endpoint.hostname)) throw new Error("Unexpected reciprocal fixture authority.");
interface RequestType {
  role: "sdk" | "candidate"; method: string; path: string; api: boolean; capability: boolean;
  authorization: boolean; negotiation: boolean; ifMatch: boolean; ifNoneMatch: string | null;
  payloadBytes: number; payloadSha256: string;
}
const requests: RequestType[] = [];
const authorizations: Array<{ method: string; key: string; approved: boolean }> = [];
let loseReply = false, unknownAttempts = 0, replaceCapability = false, wrongOriginDispatches = 0;
function transport(role: "sdk" | "candidate"): typeof fetch {
  return async (input, init) => {
    const request = new Request(input, init), url = new URL(request.url);
    if (url.origin !== endpoint.origin) { wrongOriginDispatches++; throw new Error("Reciprocal transport refused foreign authority."); }
    if (requests.length >= 128) throw new Error("Reciprocal request allowance exceeded.");
    const reader = request.clone().body?.getReader(), digest = createHash("sha256");
    let payloadBytes = 0;
    if (reader) {
      try {
        for (;;) {
          const item = await reader.read(); if (item.done) break;
          payloadBytes += item.value.length;
          if (payloadBytes > 131072) throw new Error("Reciprocal payload allowance exceeded.");
          digest.update(item.value);
        }
      } catch (reason) {
        const settled = await Promise.allSettled([reader.cancel(reason), request.body?.cancel(reason)]);
        const faults: unknown[] = [reason];
        for (const result of settled) if (result.status === "rejected") faults.push(result.reason);
        throw new AggregateError(faults, "Reciprocal payload/retirement failed.");
      } finally { reader.releaseLock(); }
    }
    const api = url.pathname.startsWith("/api/v1/");
    requests.push({ role, method: request.method, path: url.pathname, api,
      capability: url.searchParams.has("signature"), authorization: request.headers.has("authorization"),
      negotiation: request.headers.get("accept") === "application/json;type=signed-url",
      ifMatch: request.headers.has("if-match"), ifNoneMatch: request.headers.get("if-none-match"),
      payloadBytes, payloadSha256: digest.digest("hex") });
    const response = await fetch(request);
    if (role === "candidate" && replaceCapability && api && request.method === "GET") {
      replaceCapability = false;
      await response.body?.cancel();
      return new Response(JSON.stringify({ url: "http://unapproved.invalid/data?signature=authored" }), {
        status: 200, headers: { "content-type": "application/json" }
      });
    }
    if (role === "candidate" && !api && request.method === "PUT" && url.pathname.endsWith("/candidate-uncertain")) {
      unknownAttempts++;
      if (loseReply && response.status === 200) {
        loseReply = false; await response.body?.cancel();
        throw new Error("Authored lost candidate PUT acknowledgement after native publication.");
      }
    }
    return response;
  };
}
const sdk = getStore({ name: "fixture", siteID: "fixture-site", token: "fixture-only-netlify", apiURL: endpoint.origin, fetch: transport("sdk") });
const client = createNetlifyClient({ profile: NETLIFY_PROFILE, api: endpoint.origin, site: "fixture-site", store: "fixture",
  token: "fixture-only-netlify", fetch: transport("candidate"), allowHttp: true,
  authorizeDataURL(url, request) {
    const approved = new URL(url).origin === endpoint.origin;
    authorizations.push({ method: request.method, key: request.key, approved });
    return approved;
  }
});
const constructorIO = { requests: requests.length, authorizations: authorizations.length };
const original = (seed: number, size: number): Uint8Array => Uint8Array.from({ length: size }, (_, index) => (index * seed + (index >>> 7) + seed) & 255);
const metadata = { source: "official-sdk", label: "café / 雪 / ☁️", "κλειδί": { present: true, empty: "" } };
const sdkToCandidate: unknown[] = [], candidateToSdk: unknown[] = [];
for (const [index, size] of [0, 131072].entries()) {
  const bytes = original(17, size), key = "sdk-" + index;
  const written = await sdk.set(key, bytes.buffer, { metadata, onlyIfNew: true });
  if (!written.modified) throw new Error("Official SDK original was not created.");
  const result = await client.get(key), head = await client.head(key);
  if (result.state !== "present" || head.state !== "present") throw new Error("Candidate did not observe SDK original.");
  sdkToCandidate.push({ key, bytes: Buffer.from(result.bytes).toString("base64"), metadata: result.metadata,
    size: result.size, head: { state: head.state, etag: head.etag ?? null, size: head.size ?? null, metadata: head.metadata } });
}
let currentEtag: string | undefined;
for (const [index, size] of [0, 131072].entries()) {
  const bytes = original(29, size), key = "candidate-" + index;
  const written = await client.put(key, bytes, { condition: { kind: "new" } });
  const result = await sdk.getWithMetadata(key, { type: "arrayBuffer" });
  if (!result || !(result.data instanceof ArrayBuffer)) throw new Error("Official SDK did not observe candidate bytes.");
  candidateToSdk.push({ key, receipt: written, bytes: Buffer.from(result.data).toString("base64"), metadata: result.metadata });
  if (index === 1) currentEtag = written.etag;
}
const refused = await client.put("candidate-1", new Uint8Array([9]), { condition: { kind: "new" } });
const stale = await client.put("candidate-1", new Uint8Array([8]), { condition: { kind: "match", etag: '"not-current"' } });
const afterRefusals = Buffer.from(await sdk.get("candidate-1", { type: "arrayBuffer" })).toString("base64");
if (!currentEtag) throw new Error("Native acknowledgement did not supply matchable ETag.");
const matched = await client.put("candidate-1", new Uint8Array([17, 0, 251]), { condition: { kind: "match", etag: currentEtag } });
const afterMatched = Buffer.from(await sdk.get("candidate-1", { type: "arrayBuffer" })).toString("base64");
const listed = await client.list();
const beforeRefusal = requests.length;
replaceCapability = true;
let refusedCapability = false;
try { await client.get("sdk-1"); } catch (reason) { refusedCapability = reason instanceof NetlifyError && reason.code === "capability-refused"; }
const capabilityRefusalRequests = requests.length - beforeRefusal;
loseReply = true;
let unknown: { outcome: string; operation: string; key: string } | null = null;
try { await client.put("candidate-uncertain", new Uint8Array([7, 0, 255]), { condition: { kind: "new" } }); }
catch (reason) { if (reason instanceof NetlifyPublicationError) unknown = { outcome: reason.outcome, operation: reason.operation, key: reason.key }; else throw reason; }
const publishedAfterUnknown = Buffer.from(await sdk.get("candidate-uncertain", { type: "arrayBuffer" })).toString("base64");
const deleted = await client.delete("candidate-0"), deletedAgain = await client.delete("candidate-0");
const absent = await client.head("candidate-0"), sdkAbsent = await sdk.get("candidate-0", { type: "arrayBuffer" });
console.log("RECEIPT:" + JSON.stringify({ profile: "netlify-blobs-11.1.7-local-reciprocal-v1", candidate: true, constructorIO,
  sdkToCandidate, candidateToSdk, refused, stale, afterRefusals, matched, afterMatched, listed, refusedCapability,
  capabilityRefusalRequests, wrongOriginDispatches, unknown, unknownAttempts, publishedAfterUnknown,
  deleted, deletedAgain, absent, sdkAbsent, requests, authorizations }));
`;

/** One owned official server and its independently invoked public SDK; no live service is contacted. */
export class NetlifyFixture implements AsyncDisposable {
  readonly #container: StartedTestContainer;
  readonly #release: () => Promise<void>;
  readonly #candidateSha256: string | undefined;
  #closing: Promise<void> | undefined;
  constructor(container: StartedTestContainer, release: () => Promise<void>, candidateSha256?: string) {
    this.#container = container;
    this.#release = release;
    this.#candidateSha256 = candidateSha256;
  }
  close(): Promise<void> {
    return this.#closing ??= this.#release();
  }
  [Symbol.asyncDispose](): Promise<void> {
    return this.close();
  }
  /** Run one fixed bounded oracle, retaining full original bytes in its receipt rather than candidate-produced hashes. */
  async observe(): Promise<Record<string, unknown>> {
    return await this.#observe("/fixture/oracle.ts");
  }
  /** Run only the separately hash-admitted candidate; SDK-only admission remains usable without it. */
  async observeCandidate(): Promise<Record<string, unknown>> {
    if (this.#candidateSha256 === undefined) throw new Error("Separate candidate execution admission is required.");
    return { ...await this.#observe("/fixture/reciprocal.ts"), candidateSha256: this.#candidateSha256 };
  }
  async #observe(program: "/fixture/oracle.ts" | "/fixture/reciprocal.ts"): Promise<Record<string, unknown>> {
    try {
      const raw = execFileSync("docker", [
        "exec",
        this.#container.getId(),
        "timeout",
        "--signal=KILL",
        "30s",
        "node",
        "--max-old-space-size=128",
        program,
      ], { encoding: "utf8", timeout: 45000, maxBuffer: 2 * 1048576, killSignal: "SIGKILL" });
      const lines = raw.split(/\r?\n/u).filter((line) => line.startsWith("RECEIPT:"));
      if (lines.length !== 1) throw new Error("Native Netlify receipt is missing or duplicated.");
      return object(JSON.parse(lines[0]!.slice(8)));
    } catch (reason) {
      await close([() => this.close()], [reason]);
      throw reason;
    }
  }
}

/**
 * Start only an explicitly reviewed inert closure. The private network namespace
 * permits localhost SDK/server exchange while denying external network access.
 * Server storage is bounded tmpfs; constructor/startup failures still retire the
 * Testcontainers-owned ID. Docker quota readback is evidence separate from APIs.
 */
export async function openNetlify(admission: NetlifyAdmissionType): Promise<NetlifyFixture> {
  const contents = copies(admission);
  const { GenericContainer, Wait, getContainerRuntimeClient } = await import("testcontainers");
  const runtime = await getContainerRuntimeClient(), releases: (() => Promise<unknown>)[] = [];
  const release = (): Promise<void> => close([...releases].reverse());
  const startup: Buffer[] = [];
  let logBytes = 0;
  const label = randomUUID();
  class OwnedContainer extends GenericContainer {
    constructor() {
      super(NETLIFY_IMAGE);
      this.hostConfig.MemorySwap = 1073741824;
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
    const container = await new OwnedContainer().withLabels({ "opfs.fixture": label }).withNetworkMode("none").withUser(
      "65534:65534",
    )
      .withDroppedCapabilities("ALL").withSecurityOpt("no-new-privileges")
      .withTmpFs({ "/data": "rw,noexec,nosuid,size=32m,uid=65534,gid=65534,mode=0700" })
      .withCopyContentToContainer([...contents, { content: SERVER, target: "/fixture/server.ts", mode: 0o444 }, {
        content: ORACLE,
        target: "/fixture/oracle.ts",
        mode: 0o444,
      }, {
        content: CANDIDATE,
        target: "/fixture/reciprocal.ts",
        mode: 0o444,
      }])
      .withEntrypoint(["node"]).withCommand(["--max-old-space-size=128", "/fixture/server.ts"]).withResourcesQuota({
        memory: 1,
        cpu: 1,
      })
      .withLogConsumer((stream) => {
        stream.on("data", (chunk: unknown) => {
          if (logBytes >= 65536) return;
          const raw = chunk instanceof Uint8Array ? Buffer.from(chunk) : Buffer.from(String(chunk));
          const bytes = raw.subarray(0, 65536 - logBytes);
          startup.push(Buffer.from(bytes));
          logBytes += bytes.length;
        });
      })
      .withWaitStrategy(Wait.forLogMessage("OPFS NETLIFY SDK SERVER READY")).withStartupTimeout(60000).start();
    releases.push(async () => {
      await container.stop({ remove: false, timeout: 5000 });
      inspect(container.getId(), false);
    });
    inspect(container.getId(), true);
    return new NetlifyFixture(container, release, admission.candidate?.sha256);
  } catch (reason) {
    console.error("Netlify SDK startup diagnostics (bounded, fixture-only):", Buffer.concat(startup).toString());
    await close([release], [reason]);
    throw reason;
  }
}
