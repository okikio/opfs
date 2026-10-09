/** Native byte-view admission shared by upload and response readers. @module */

/** Captures intrinsic admission capabilities once; caller tags cannot replace them. */
const tag = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype), Symbol.toStringTag)?.get;
const at = Uint8Array.prototype.at;
const typed = Object.getPrototypeOf(Uint8Array.prototype);
const buffer = Object.getOwnPropertyDescriptor(typed, "buffer")!.get!;
const byteOffset = Object.getOwnPropertyDescriptor(typed, "byteOffset")!.get!;
const byteLength = Object.getOwnPropertyDescriptor(typed, "byteLength")!.get!;
const viewBuffer = Object.getOwnPropertyDescriptor(DataView.prototype, "buffer")!.get!;
const viewOffset = Object.getOwnPropertyDescriptor(DataView.prototype, "byteOffset")!.get!;
const viewLength = Object.getOwnPropertyDescriptor(DataView.prototype, "byteLength")!.get!;
const Bytes = Uint8Array;
const length = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, "byteLength")!.get!;
const resizable = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, "resizable")?.get;

/**
 * Accepts genuine readable Uint8Array views across realms, including Buffer/subclasses.
 * The native tag reads the typed-array brand rather than a spoofable tag. Native
 * at(Infinity) validates the backing store without reading/copying a byte; detached
 * or out-of-bounds views are refused, while genuine empty views remain valid.
 * This admission does not prevent a caller detaching/resizing the buffer later.
 * DataView, other typed arrays, objects, strings and proxies are not byte chunks.
 */
export function isBytes(value: unknown): value is Uint8Array {
  if (!ArrayBuffer.isView(value) || tag?.call(value) !== "Uint8Array") return false;
  try {
    at.call(value, Infinity);
    return true;
  } catch {
    return false;
  }
}

/**
 * Captures the readable raw range of a genuine native ArrayBufferView.
 *
 * The returned plain byte view shares its backing without copying bytes. Native
 * getters and validation ignore caller-owned metadata, subclass methods and
 * species. Typed array inputs mean their raw bytes, including non-byte arrays;
 * only isBytes authorizes the narrower streamed/upload chunk contract. Detached
 * and out-of-bounds backing fails before a zero-length view can mask that fault.
 * This fixes the range at admission; it does not own caller mutation, detachment
 * or later resize, and it cannot make shared memory an atomic snapshot.
 */
export function toView(value: ArrayBufferView): Uint8Array {
  if (!ArrayBuffer.isView(value)) throw new TypeError("A byte range must be a native ArrayBufferView.");
  if (tag?.call(value) !== undefined) {
    at.call(value, Infinity);
    return new Bytes(buffer.call(value), byteOffset.call(value), byteLength.call(value));
  }
  const size: number = viewLength.call(value);
  return new Bytes(viewBuffer.call(value), viewOffset.call(value), size);
}

/**
 * Gives Fetch a fixed, non-shared backing store for an admitted native byte range.
 * Raw BodyInit views and admitted byte chunks retain their native range.
 * Ordinary offset views keep their existing bytes without an extra copy. Shared
 * and resizable backing is copied once before hashing/signing and dispatch, so
 * Web IDL's BodyInit restrictions cannot become a dispatched publication fault.
 * A copy of concurrently modified shared memory is not an atomic application
 * snapshot; callers still own synchronization while supplying their bytes.
 */
export function toRequestBytes(value: ArrayBufferView): Uint8Array<ArrayBuffer> {
  const view = toView(value);
  const backing: unknown = buffer.call(view);
  try {
    length.call(backing);
    if (resizable?.call(backing) !== true) return view as Uint8Array<ArrayBuffer>;
  } catch {
    // The ArrayBuffer intrinsic rejects SharedArrayBuffer without realm checks.
  }
  return new Bytes(view);
}
