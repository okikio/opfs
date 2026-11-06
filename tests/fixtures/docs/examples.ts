/** Behavioral assertions for actual extracted Markdown declarations, using authored peers and a frozen independent ZIP. */
import { deepStrictEqual, equal, ok, rejects } from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createFileSystem } from "../../../mod.ts";
import { createRecordAdapter } from "../../../src/adapter/record.ts";
import { defineRecordDriver } from "../../../src/driver/record.ts";
import type { RecordBackendType } from "../../../src/driver/record.ts";
import type { ByteSourceType } from "../../../src/source.ts";
import { createByteSource } from "../../../src/source.ts";
import { createNativeTink } from "../../../src/crypto/tink.ts";
import type { FetchType } from "../../../src/request.ts";
import type { TusClientOptionsType } from "../../../src/tus.ts";
import type { TransferCheckpointType } from "../../../src/transfer.ts";

/** Frozen Python-stdlib ZIP is an independent container oracle, not a candidate-writer round trip. */
function zip(): Uint8Array {
  const bytes = readFileSync(fileURLToPath(new URL("../archive/preview.zip", import.meta.url).href));
  equal(
    createHash("sha256").update(bytes).digest("hex"),
    "f9a09febfc9fdd377d8d35ff1a3c8b63c82b3de0d73273fa0a455d74b29bc5bb",
  );
  return new Uint8Array(bytes);
}

/** Slices retain one explicit read observer; inspecting the borrowed input bypasses this observer. */
class ObservedBlob extends Blob {
  readonly #read: () => void;
  constructor(bytes: BlobPart[], read: () => void) {
    super(bytes);
    this.#read = read;
  }
  override slice(start?: number, end?: number, type?: string): Blob {
    return new ObservedBlob([super.slice(start, end, type)], this.#read);
  }
  override async arrayBuffer(): Promise<ArrayBuffer> {
    this.#read();
    return await super.arrayBuffer();
  }
}

/** Exercise pre-abort and cancellation at every observed physical input read, then reopen the same borrowed bytes. */
async function boundaries(input: Uint8Array, invoke: (blob: Blob, signal: AbortSignal) => Promise<unknown>) {
  let reads = 0;
  const original = new Uint8Array(input);
  const blob = new ObservedBlob([new Uint8Array(input)], () => {
    reads++;
  });
  await invoke(blob, new AbortController().signal);
  const total = reads;
  ok(total > 0 && total <= 128);
  const before = reads;
  const stopped = new AbortController();
  stopped.abort(new Error("authored pre-abort"));
  await rejects(() => invoke(blob, stopped.signal));
  equal(reads, before);
  for (let boundary = 1; boundary <= total; boundary++) {
    const controller = new AbortController();
    let at = 0;
    const reason = new Error(`authored input boundary ${boundary}`);
    const observed = new ObservedBlob([new Uint8Array(input)], () => {
      at++;
      if (at === boundary) controller.abort(reason);
    });
    await rejects(() => invoke(observed, controller.signal));
    equal(at, boundary, "no next physical read follows abort");
    deepStrictEqual(new Uint8Array(await Blob.prototype.arrayBuffer.call(observed)), original);
  }
  await invoke(blob, new AbortController().signal);
  deepStrictEqual(new Uint8Array(await Blob.prototype.arrayBuffer.call(blob)), original);
}

export async function archive(preview: (blob: Blob, signal?: AbortSignal) => Promise<Uint8Array | undefined>) {
  await boundaries(zip(), async (blob, signal) => {
    const bytes = await preview(blob, signal);
    deepStrictEqual(bytes, new Uint8Array(4096).fill(90));
  });
}

export async function encrypted(
  preview: (
    blob: Blob,
    key: Uint8Array,
    aad: Uint8Array,
    signal?: AbortSignal,
  ) => Promise<null | { bytes: Uint8Array }>,
) {
  const key = new Uint8Array(32).fill(7), aad = new Uint8Array([2, 3, 5]);
  // This qualifies composition/cancellation only. Independent Tink format vectors have their own tests.
  const stream = createNativeTink().encrypt(createByteSource(zip()), key, aad);
  const ciphertext = new Uint8Array(await new Response(stream).arrayBuffer());
  await boundaries(ciphertext, async (blob, signal) => {
    const result = await preview(blob, key, aad, signal);
    ok(result !== null);
    deepStrictEqual(result.bytes, new Uint8Array(4096).fill(90));
  });
  deepStrictEqual(key, new Uint8Array(32).fill(7));
  deepStrictEqual(aad, new Uint8Array([2, 3, 5]));
}

export async function records(create: () => RecordBackendType) {
  const backend = create();
  const driver = defineRecordDriver(backend, { name: "docs-check", disposeBackend: true });
  const files = createFileSystem(createRecordAdapter(driver, { disposeDriver: true }), {
    disposeAdapter: true,
    coordination: "local",
  });
  try {
    await files.writeFile("/notes/draft.txt", "First draft", { parents: true });
    await files.writeFile("/notes/sub/other.txt", "Other", { parents: true });
    equal(await files.readText("/notes/draft.txt"), "First draft");
    const record = await backend.get("/notes/draft.txt");
    ok(record !== null);
    const pristine = structuredClone(record);
    Object.assign(record, { path: "/mutated" });
    deepStrictEqual(await backend.get("/notes/draft.txt"), pristine);
    const paths: string[] = [];
    for await (const child of backend.list("/notes")) paths.push(child.path);
    deepStrictEqual(paths.sort(), ["/notes/draft.txt", "/notes/sub"]);
  } finally {
    await files[Symbol.asyncDispose]();
  }
  equal(await backend.get("/notes/draft.txt"), null);
  const remaining = [];
  for await (const child of backend.list("/notes")) remaining.push(child);
  deepStrictEqual(remaining, []);
}

export async function extension(create: (input: Uint8Array, identity: string) => ByteSourceType) {
  const input = new Uint8Array([2, 3, 5, 7]), source = create(input, "primes-v1");
  input.fill(0);
  const result = await source.read(1, 2);
  deepStrictEqual(result, new Uint8Array([3, 5]));
  result.fill(99);
  deepStrictEqual(await source.read(0, 4), new Uint8Array([2, 3, 5, 7]));
  const controller = new AbortController();
  controller.abort();
  await rejects(() => source.read(0, 1, { signal: controller.signal }));
  await rejects(() => source.read(3, 2));
}

interface StorageType {
  read(): Promise<string | null>;
  replace(value: string): Promise<void>;
}
type StartType = (
  source: ByteSourceType,
  connection: TusClientOptionsType,
  storage: StorageType,
  signal?: AbortSignal,
  pause?: () => boolean,
) => Promise<TransferCheckpointType>;
type ContinueType = (
  source: ByteSourceType,
  connection: TusClientOptionsType,
  storage: StorageType,
  signal?: AbortSignal,
) => Promise<TransferCheckpointType>;

/** Authored tus peer follows the existing tus.test.ts recipe; it owns bytes and independently checks every acknowledged offset. */
export async function transfer(start: StartType, resume: ContinueType, Initial: new (...args: never[]) => Error) {
  const bytes: number[] = [], methods: string[] = [];
  let creates = 0, saved: string | null = null;
  const fetch: FetchType = async (_input, init = {}) => {
    const method = init.method ?? "GET", headers = new Headers(init.headers);
    methods.push(method);
    if (method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: { "Tus-Version": "1.0.0", "Tus-Extension": "creation", "Tus-Max-Size": "4" },
      });
    }
    equal(headers.get("Tus-Resumable"), "1.0.0");
    const reply = { "Tus-Resumable": "1.0.0" };
    if (method === "POST") {
      creates++;
      return new Response(null, { status: 201, headers: { ...reply, Location: "/upload/one" } });
    }
    if (method === "HEAD") {
      return new Response(null, { headers: { ...reply, "Upload-Offset": String(bytes.length), "Upload-Length": "4" } });
    }
    equal(method, "PATCH");
    equal(headers.get("Upload-Offset"), String(bytes.length));
    equal(headers.get("Content-Type"), "application/offset+octet-stream");
    bytes.push(...new Uint8Array(await new Response(init.body).arrayBuffer()));
    return new Response(null, { status: 204, headers: { ...reply, "Upload-Offset": String(bytes.length) } });
  };
  const connection = { endpoint: "https://tus.example/uploads", fetch };
  const storage: StorageType = {
    async read() {
      return saved;
    },
    async replace(value) {
      saved = value;
    },
  };
  const source = () => createByteSource(new Uint8Array([2, 3, 5, 7]), { identity: "docs-primes-v1" });
  const paused = await start(source(), connection, storage, undefined, () => bytes.length === 4);
  equal(paused.state, "paused");
  equal(paused.offset, 4);
  equal(creates, 1);
  ok(saved !== null);
  // A distinct invocation and new source instance restore solely the persisted JSON, not the returned object.
  const completed = await resume(source(), connection, storage);
  equal(completed.state, "completed");
  equal(completed.offset, 4);
  equal(creates, 1);
  deepStrictEqual(bytes, [2, 3, 5, 7]);
  equal(methods.filter((method) => method === "PATCH").length, 1);
  await rejects(() => start(source(), connection, storage));
  equal(creates, 1);
  saved = null;
  bytes.length = 0;
  const failure = new Error("authored initial durable publication failure");
  let caught: unknown;
  try {
    await start(source(), connection, {
      ...storage,
      async replace() {
        throw failure;
      },
    });
  } catch (reason) {
    caught = reason;
  }
  ok(caught instanceof Initial);
  equal(caught.cause, failure);
  ok("checkpoint" in caught);
  const checkpoint = caught.checkpoint;
  ok(typeof checkpoint === "object" && checkpoint !== null && "destination" in checkpoint);
  equal(creates, 2);
  deepStrictEqual(bytes, []);
  await storage.replace(JSON.stringify(checkpoint));
  equal((await resume(source(), connection, storage)).state, "completed");
  equal(creates, 2);
  deepStrictEqual(bytes, [2, 3, 5, 7]);
}

/** GCS JSON metadata and guarded range peer; no ambient Fetch replacement or network access. */
export async function remote(
  preview: (
    bucket: string,
    key: string,
    token: () => Promise<string>,
    fetch: FetchType,
    signal?: AbortSignal,
  ) => Promise<null | { bytes: Uint8Array }>,
) {
  const input = zip();
  let requests = 0;
  async function invoke(stopAt: number, preabort = false) {
    const controller = new AbortController();
    if (preabort) controller.abort(new Error("authored pre-abort"));
    let count = 0;
    const fetch: FetchType = async (url, init = {}) => {
      ok(init.signal, "every metadata and range request retains cancellation authority");
      init.signal?.throwIfAborted();
      count++;
      requests++;
      if (count === stopAt) {
        controller.abort(new Error("authored remote boundary"));
        init.signal?.throwIfAborted();
      }
      const address = new URL(String(url));
      const headers = new Headers(init.headers);
      equal(headers.get("Authorization"), "Bearer fixture-token");
      if (address.searchParams.get("alt") !== "media") {
        return Response.json({
          name: "preview.zip",
          size: String(input.length),
          generation: "42",
          etag: "metadata-only",
        });
      }
      equal(address.searchParams.get("generation"), "42");
      const match = /^bytes=(\d+)-(\d+)$/.exec(headers.get("Range") ?? "");
      ok(match);
      const from = Number(match[1]), to = Number(match[2]);
      return new Response(input.slice(from, to + 1), {
        status: 206,
        headers: {
          "Content-Range": `bytes ${from}-${to}/${input.length}`,
          "Content-Length": String(to - from + 1),
          "x-goog-generation": "42",
        },
      });
    };
    const result = await preview("fixture", "preview.zip", async () => "fixture-token", fetch, controller.signal);
    ok(result !== null);
    deepStrictEqual(result.bytes, new Uint8Array(4096).fill(90));
    return count;
  }
  const total = await invoke(0), before = requests;
  ok(total > 1 && total <= 128);
  await rejects(() => invoke(0, true));
  equal(requests, before);
  for (let boundary = 1; boundary <= total; boundary++) await rejects(() => invoke(boundary));
  await invoke(0);
}
