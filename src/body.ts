/**
 * Response bodies from provider clients: native stream admission and exact-length reading.
 *
 * @module
 */
import { isBytes, toView } from "./bytes.ts";
import { close } from "./close.ts";
import { openBytes, withAbortSignal } from "./stream/mod.ts";

/** Native slot inspection across realms, without acquiring a reader or reading bytes. */
const locked = Object.getOwnPropertyDescriptor(ReadableStream.prototype, "locked")?.get;

/**
 * Accepts an actual native Web ReadableStream branded by this runtime's intrinsic.
 * The intrinsic locked getter inspects its stream slots; it does not call a
 * caller's getReader/cancel methods or infer ownership from duck-shaped fields.
 * Locked, closed and errored streams still have that brand. Their later owned
 * acquisition/retirement can refuse or fail independently of this pure admission.
 * Foreign prototypes are accepted where the runtime preserves their native brand.
 * Replacing a prototype can destroy that brand in some runtimes. Custom objects
 * and polyfills without native stream slots remain outside this union.
 */
export function isStream(value: unknown): value is ReadableStream<Uint8Array> {
  try {
    return typeof locked?.call(value) === "boolean";
  } catch {
    return false;
  }
}

/** One bounded, lazy native capability observation for the current constructor pair. */
let requestStream: {
  readonly request: typeof Request;
  readonly stream: typeof ReadableStream;
  readonly supported: boolean;
} | undefined;

/**
 * Observes native Request stream admission without network or caller input.
 * A stream body must remain the same stream and must not acquire a synthesized
 * text Content-Type. Constructor acceptance alone is insufficient: a runtime
 * can coerce the stream to a string. A private closed probe needs no reader,
 * cancellation or detached work. Import and client construction do not probe.
 * The result describes Request construction, not provider or network support.
 */
export function supportsRequestStream(): boolean {
  if (typeof Request !== "function" || typeof ReadableStream !== "function") return false;
  const request = Request, stream = ReadableStream;
  if (requestStream?.request === request && requestStream.stream === stream) return requestStream.supported;
  let supported = false;
  try {
    const body = new stream<Uint8Array>({
      start(controller) {
        controller.close();
      },
    }, { highWaterMark: 0 });
    const init: RequestInit & { duplex: "half" } = { method: "POST", body, duplex: "half" };
    const probe = new request("https://opfs.invalid/stream-capability", init);
    supported = probe.body === body && !probe.headers.has("content-type");
  } catch {
    // A native refusal is unsupported; the probe has no borrowed owner to retire.
  }
  requestStream = { request, stream, supported };
  return supported;
}

/** Refuses default native raw-stream dispatch before signing or acquiring caller input. */
export function assertRequestStream(): void {
  if (!supportsRequestStream()) {
    throw new TypeError(
      "The default Fetch transport does not admit native request streams. " +
        "Use put() for bounded byte-part uploads or provide a Fetch implementation that consumes stream bytes.",
    );
  }
}

/** Options for {@link exactLength}. */
export interface ExactLengthOptionsType {
  /**
   * Names the body in errors, such as `Box body` or `Git LFS body`:
   * `"Box body is truncated."`.
   */
  readonly label: string;
  /** Names the resource for abort errors, such as `Box content`. Defaults to `label`. */
  readonly resource?: string;
  /** Cancels the source and fails the stream when aborted. */
  readonly signal?: AbortSignal | undefined;
}

/**
 * Passes a response body through only if it has exactly `length` bytes.
 *
 * A storage API that says a file has 10 bytes and then sends 9, or 11, has
 * failed; handing the caller a short file as if it were complete would hide
 * that. The returned stream errors with a `TypeError` when the body ends
 * early, runs past `length`, yields a non-byte chunk, or sends more than 16
 * empty chunks in a row. Pass `undefined` when the API gave no length: then
 * only the byte and progress checks apply.
 *
 * The returned stream owns the source's reader. Cancelling it, an error, or
 * the abort signal cancels the source once and releases the reader. It pulls
 * one chunk per read (`highWaterMark: 0`), so nothing is buffered ahead of the
 * consumer.
 *
 * @example
 * ```ts
 * const body = exactLength(response.body!, Number(response.headers.get("content-length")), {
 *   label: "Box body",
 *   resource: "Box content",
 *   signal,
 * });
 * ```
 */
export function exactLength(
  source: ReadableStream<Uint8Array>,
  length: number | undefined,
  options: ExactLengthOptionsType,
): ReadableStream<Uint8Array> {
  const label = options.label;
  const reader = openBytes(source);
  let seen = 0, empty = 0, ended = false;
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        let next: ReadableStreamReadResult<Uint8Array>;
        try {
          next = await reader.read();
        } catch (reason) {
          // A rejected read already ended the source; cancelling it again would
          // report the same failure twice.
          ended = true;
          throw reason;
        }
        // Cancellation can settle a pending read with done: that is not the end
        // of the body and must not be reported as truncation.
        if (ended) return;
        if (next.done) {
          ended = true;
          if (length !== undefined && seen !== length) throw new TypeError(`${label} is truncated.`);
          reader.releaseLock();
          controller.close();
          return;
        }
        if (!isBytes(next.value)) throw new TypeError(`${label} requires bytes.`);
        const chunk = toView(next.value);
        if (
          chunk.length > Number.MAX_SAFE_INTEGER - seen || (length !== undefined && chunk.length > length - seen)
        ) throw new TypeError(`${label} exceeds its declared extent.`);
        if (chunk.length === 0) {
          if (++empty > 16) throw new TypeError(`${label} makes no progress.`);
        } else empty = 0;
        seen += chunk.length;
        controller.enqueue(chunk);
      } catch (reason) {
        try {
          await close([...(ended ? [] : [() => reader.cancel(reason)]), () => reader.releaseLock()], [reason]);
        } catch (failure) {
          controller.error(failure);
        }
        ended = true;
      }
    },
    async cancel(reason) {
      if (ended) return;
      ended = true;
      await close([() => reader.cancel(reason), () => reader.releaseLock()]);
    },
  }, { highWaterMark: 0 });
  return withAbortSignal(stream, options.signal, options.resource ?? label, "download");
}
