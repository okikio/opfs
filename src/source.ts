/** Explicit byte sources for archive access and checkpoint replay. @module */
import type { ObjectBackendType, ObjectRevisionType } from "./driver/object.ts";
import { close } from "./close.ts";
import { isBytes, toView } from "./bytes.ts";

/** Cancellation is borrowed; each read owns only the work it starts. */
export interface SourceReadOptionsType {
  readonly signal?: AbortSignal;
}

/** Known-size addressable bytes. A read must return exactly the admitted extent.
 *
 * Identity names an immutable snapshot or an explicit caller assertion. The
 * stability field describes the evidence; an identifier alone is not proof.
 * Implementations and their resources are borrowed by archive/transfer readers.
 */
export interface ByteSourceType {
  readonly size: number;
  readonly identity?: string;
  readonly stability?: "immutable" | "provider" | "caller";
  read(offset: number, length: number, options?: SourceReadOptionsType): Promise<Uint8Array>;
}

/** A one-shot stream is not addressable or restartable merely because it has bytes. */
export interface StreamSourceType {
  readonly stream: ReadableStream<Uint8Array>;
  readonly size?: number;
}

/** Shared admission policy for physical reads across nested readers. */
export interface SourceBudgetOptionsType {
  readonly maxBytes: number;
  readonly maxRequests: number;
}

/** Counts reserved work, including failed requests, so retries cannot evade limits. */
export interface SourceBudgetType {
  reserve(bytes: number): void;
  inspect(): { readonly bytes: number; readonly requests: number };
}

/** Rejects unsafe arithmetic before allocation or source acquisition. */
function integer(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`${name} must be a nonnegative safe integer.`);
}

/** Admits a complete extent without clamping or pretending a short read succeeded. */
export function sourceRange(size: number, offset: number, length: number): void {
  integer(size, "size");
  integer(offset, "offset");
  integer(length, "length");
  if (offset > size || length > size - offset) throw new RangeError("Byte source extent exceeds its snapshot.");
}

/** Creates a per-operation ledger. Share the same value through nested source wrappers. */
export function createSourceBudget(options: SourceBudgetOptionsType): SourceBudgetType {
  const { maxBytes, maxRequests } = options;
  integer(maxBytes, "maxBytes");
  integer(maxRequests, "maxRequests");
  let bytes = 0;
  let requests = 0;
  return {
    reserve(length) {
      integer(length, "length");
      if (length > maxBytes - bytes || requests >= maxRequests) throw new RangeError("Byte source budget exhausted.");
      bytes += length;
      requests++;
    },
    inspect: () => ({ bytes, requests }),
  };
}

/** Wraps an injected source with exact-read validation and a shared physical-read ledger.
 * No disposal ownership transfers. This accounts requested extents, not hidden
 * work inside an arbitrary implementation; that implementation must report its
 * own transport/decoder costs. Empty reads perform no source I/O.
 */
export function budgetSource(source: ByteSourceType, budget: SourceBudgetType): ByteSourceType {
  const { size, identity, stability } = source;
  integer(size, "size");
  return {
    size,
    ...(identity === undefined ? {} : { identity }),
    ...(stability === undefined ? {} : { stability }),
    async read(offset, length, options = {}) {
      options.signal?.throwIfAborted();
      sourceRange(size, offset, length);
      if (length === 0) return new Uint8Array();
      budget.reserve(length);
      const bytes = await source.read(offset, length, options);
      options.signal?.throwIfAborted();
      if (!isBytes(bytes)) throw new TypeError("Byte source returned a non-byte extent.");
      const view = toView(bytes);
      if (view.byteLength !== length) {
        throw new TypeError("Byte source returned a different extent than requested.");
      }
      return view;
    },
  };
}

/** Borrows an immutable Blob. A caller identity is an assertion used for resume comparison. */
export function createBlobSource(blob: Blob, options: { readonly identity?: string } = {}): ByteSourceType {
  const { size } = blob;
  integer(size, "size");
  return {
    size,
    ...(options.identity === undefined ? {} : { identity: options.identity }),
    stability: "immutable",
    async read(offset, length, { signal } = {}) {
      signal?.throwIfAborted();
      sourceRange(size, offset, length);
      const bytes = new Uint8Array(await blob.slice(offset, offset + length).arrayBuffer());
      signal?.throwIfAborted();
      return bytes;
    },
  };
}

/** Owns a snapshot copy; later mutations to the input cannot change an archive index. */
export function createByteSource(bytes: Uint8Array, options: { readonly identity?: string } = {}): ByteSourceType {
  return createBlobSource(new Blob([new Uint8Array(bytes)]), options);
}

/** The read-only object contract needed by a source. Clients and drivers need not share limit metadata. */
export type ObjectSourceBackendType = Pick<ObjectBackendType, "identity" | "head" | "get"> & {
  readonly capabilities: Pick<ObjectBackendType["capabilities"], "rangeRead">;
};

/** Policy for a bounded remote object snapshot. */
export interface ObjectSourceOptionsType extends SourceReadOptionsType {
  /** Explicit namespace identity for a backend that cannot supply one. Must distinguish services and buckets. */
  readonly namespace?: string;
  /** Maximum allocation per range request. Defaults to 8 MiB. */
  readonly maxReadBytes?: number;
  /** Only use when the caller can guarantee no mutation; evidence stays caller-asserted. */
  readonly assumeStable?: boolean;
}

/** Validates an exact body while retaining at most the admitted output allocation.
 * Oversized or short transport bodies fail. Cancellation retires this owned
 * response reader; it does not close the borrowed object client.
 */
async function exactBytes(
  stream: ReadableStream<Uint8Array>,
  length: number,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  const reader = stream.getReader();
  const output = new Uint8Array(length);
  let at = 0;
  let finished = false;
  let cancel: Promise<void> | undefined;
  const failures: unknown[] = [];
  const abort = () => {
    cancel = reader.cancel(signal?.reason);
    void cancel.catch(() => {});
  };
  signal?.addEventListener("abort", abort, { once: true });
  try {
    signal?.throwIfAborted();
    while (true) {
      const chunk = await reader.read();
      signal?.throwIfAborted();
      if (chunk.done) break;
      if (!isBytes(chunk.value)) throw new TypeError("Object range response returned a non-byte chunk.");
      const bytes = toView(chunk.value);
      if (bytes.byteLength > length - at) {
        throw new RangeError("Object range response exceeded its admitted extent.");
      }
      output.set(bytes, at);
      at += bytes.byteLength;
    }
    if (at !== length) throw new RangeError("Object range response was truncated.");
    finished = true;
    return output;
  } catch (reason) {
    failures.push(reason);
    throw reason;
  } finally {
    signal?.removeEventListener("abort", abort);
    await close([
      async () => {
        if (cancel !== undefined) await cancel;
        else if (!finished) await reader.cancel();
      },
      () => reader.releaseLock(),
    ], failures);
  }
}

/** Opens a revision-bound view without downloading the object.
 *
 * The backend must enforce revision conditions and honor exact byte ranges.
 * Weak ETags and bare URLs cannot establish provider snapshot evidence. A
 * caller assertion is explicitly weaker and must not be used to certify it.
 */
export async function openObjectSource(
  backend: ObjectSourceBackendType,
  key: string,
  options: ObjectSourceOptionsType = {},
): Promise<ByteSourceType> {
  const { signal, assumeStable = false, maxReadBytes = 8 * 1024 * 1024, namespace = backend.identity } = options;
  if (namespace !== undefined && namespace.length === 0) {
    throw new TypeError("Object namespace identity cannot be empty.");
  }
  integer(maxReadBytes, "maxReadBytes");
  if (maxReadBytes === 0) throw new RangeError("maxReadBytes must be positive.");
  signal?.throwIfAborted();
  if (!backend.capabilities.rangeRead) throw new TypeError("Object backend does not support range reads.");
  const stat = await backend.head(key, signal === undefined ? {} : { signal });
  signal?.throwIfAborted();
  if (stat === null) throw new Error("Object source does not exist.");
  integer(stat.size, "size");
  // Only one strong opaque tag binds a representation. '*' tests existence and
  // a comma-separated list permits several versions; neither is a snapshot.
  const strongETag = (value: string) => /^"[\x21\x23-\x7e\x80-\xff]*"$/.test(value);
  const revision: ObjectRevisionType | undefined = stat.revision === undefined
    ? stat.etag === undefined || !strongETag(stat.etag) ? undefined : { kind: "etag", value: stat.etag }
    : { ...stat.revision };
  if (
    revision !== undefined && (revision.value.length === 0 ||
      !["etag", "generation", "version"].includes(revision.kind) ||
      (revision.kind === "etag" && !strongETag(revision.value)) ||
      (revision.kind === "generation" && !/^[1-9]\d*$/.test(revision.value)))
  ) {
    throw new TypeError("Object source returned an invalid or weak revision.");
  }
  if (revision === undefined && !assumeStable) throw new TypeError("Object source has no enforceable revision.");
  const size = stat.size;
  const identity = namespace === undefined ? undefined : JSON.stringify([namespace, key, revision ?? null, size]);
  return {
    size,
    ...(identity === undefined ? {} : { identity }),
    stability: revision === undefined ? "caller" : "provider",
    async read(offset, length, { signal: readSignal } = {}) {
      readSignal?.throwIfAborted();
      sourceRange(size, offset, length);
      if (length > maxReadBytes) throw new RangeError("Object source maxReadBytes exceeded.");
      if (length === 0) return new Uint8Array();
      const stream = await backend.get(key, {
        at: offset,
        length,
        ...(revision === undefined ? {} : { revision }),
        ...(readSignal === undefined ? {} : { signal: readSignal }),
      });
      return await exactBytes(stream, length, readSignal);
    },
  };
}
