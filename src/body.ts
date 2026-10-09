/** Pure admission for the providers' native readable-body union. @module */

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
