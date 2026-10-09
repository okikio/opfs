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
const BufferPrototype = ArrayBuffer.prototype;
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
 * A clean local fixed backing keeps its bytes without an extra copy. Shared,
 * resizable, foreign, custom-prototype or own-metadata backing is copied before
 * hashing/signing and dispatch. A host may inspect ordinary backing properties
 * while extracting BodyInit, so native slots alone do not protect that boundary.
 * A copy of concurrently modified shared memory is not an atomic application
 * snapshot; callers still own synchronization while supplying their bytes.
 */
export function toRequestBytes(value: ArrayBufferView): Uint8Array<ArrayBuffer> {
  const view = toView(value);
  const backing: unknown = buffer.call(view);
  if (isCanonicalBuffer(backing)) return view as Uint8Array<ArrayBuffer>;
  return new Bytes(view);
}

/** Admits a genuine ArrayBuffer across realms, without admitting SharedArrayBuffer. */
export function isBuffer(value: unknown): value is ArrayBuffer {
  try {
    length.call(value);
    return true;
  } catch {
    return false;
  }
}

/**
 * Authorizes borrowed backing only when host extraction has no caller metadata.
 * Native brand and fixed storage are necessary but insufficient: hosts can read
 * byteLength or detached properties. The captured local prototype and absence
 * of all own keys exclude foreign/custom lookup and shadowed metadata without
 * invoking getters. Borrowing requires that shape and bytes to stay valid and
 * unchanged until settlement; admission does not freeze caller storage. Runtime
 * globals and their intrinsic prototypes are trusted.
 */
function isCanonicalBuffer(value: unknown): value is ArrayBuffer {
  return isBuffer(value) && resizable?.call(value) !== true &&
    Object.getPrototypeOf(value) === BufferPrototype && Reflect.ownKeys(value).length === 0;
}

/**
 * Validates a raw BodyInit buffer through native slots before signing or dispatch.
 * A detached buffer is not an empty body: native range construction rejects it.
 * Clean local fixed buffers without own metadata retain identity without a copy.
 * Other genuine buffers receive one clean fixed snapshot before signing/retries:
 * RAB, foreign, custom-prototype and own-metadata backing cannot expose caller
 * properties to host extraction. The copy uses native size and requires caller
 * synchronization during admission. Raw SharedArrayBuffer is outside BodyInit.
 */
export function toRequestBuffer(value: ArrayBuffer): ArrayBuffer {
  const size: number = length.call(value);
  const view = new Bytes(value, 0, size);
  return isCanonicalBuffer(value) ? value : new Bytes(view).buffer;
}
