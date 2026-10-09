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
