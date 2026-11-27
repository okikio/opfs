/**
 * Reader acquisition with proof of native delivery.
 *
 * The stream helpers must know whether a rejection they saw came from the real
 * stream or from a borrowed method. This module captures the native reader
 * methods once, at load, and records for each reader it opens whether its
 * events can be trusted. `openBytes` is the one way in.
 *
 * @module
 */
import type { AbortByteSource } from "./abort.ts";

/** Exact native acquisition binds the returned reader to this precise source. */
export const nativeGetReader = ReadableStream.prototype.getReader;

/** Captured local native prototype limits proof to lookup paths without borrowed intermediaries. */
export const nativeReader = ReadableStreamDefaultReader.prototype;

/** Exact local native read identity grants stored source-event correlation only. */
export const nativeRead = nativeReader.read;

/** Exact local native cancellation identity proves delivery of a stored source rejection. */
export const nativeCancel = nativeReader.cancel;

/** Captured local native settlement method; borrowed then methods remain invoked. */
export const nativePromise = Promise.prototype;

export const nativeThen = nativePromise.then;

/** Captured native closed accessor proves state only on a successfully branded receiver. */
export const nativeClosed = Object.getOwnPropertyDescriptor(nativeReader, "closed")?.get;

/**
 * Snapshots native accessor provenance without traversing a borrowed prototype chain.
 * A Proxy intermediary can advertise a native descriptor but execute another get
 * effect. Its declared access remains usable, but cannot certify native state.
 */
export function accessor(value: object, name: PropertyKey): (() => unknown) | undefined {
  const own = Object.getOwnPropertyDescriptor(value, name);
  if (own !== undefined) return own.get;
  const prototype = Object.getPrototypeOf(value);
  return prototype === nativeReader ? Object.getOwnPropertyDescriptor(prototype, name)?.get : undefined;
}

/**
 * Captures a local native data method before declared access can run a borrowed getter.
 *
 * Native invocation remains separate from this proof. An accessor can release its
 * receiver, delete itself and return a native method, so later descriptor lookup
 * cannot certify a stored source event. Unknown prototype chains stay usable
 * without correlation. A branded receiver is established by native acquisition
 * for private delivery, and by the independent closed receipt for closed/read.
 */
export function isNativeMethod(
  reader: object,
  name: PropertyKey,
  method: object,
  expected: object = nativeReader,
): boolean {
  const own = Object.getOwnPropertyDescriptor(reader, name);
  if (own !== undefined) return Object.hasOwn(own, "value") && own.value === method;
  const prototype = Object.getPrototypeOf(reader);
  if (prototype !== expected) return false;
  const inherited = Object.getOwnPropertyDescriptor(prototype, name);
  return inherited !== undefined && Object.hasOwn(inherited, "value") && inherited.value === method;
}

/** Private read rejection, acquisition binding and native closed-access provenance. */
export const reads = new WeakMap<ByteReaderType, {
  native: boolean;
  readonly bound: boolean;
  eligible: boolean;
  closed: { readonly promise: Promise<void>; readonly native: boolean } | undefined;
}>();

/** A settled event, including an actual rejection with null or undefined. */
export type OutcomeType<Value> = { readonly ok: true; readonly value: Value } | {
  readonly ok: false;
  readonly reason: unknown;
};

/** Observes both outcomes immediately without using reason identity as authority. */
export function settle<Value>(pending: PromiseLike<Value>): Promise<OutcomeType<Value>> {
  return Promise.resolve(pending).then(
    (value) => ({ ok: true, value }),
    (reason: unknown) => ({ ok: false, reason }),
  );
}

/** Internal reader capability bound to one exact acquired stream. */
export interface ByteReaderType {
  /** Declared reader terminal observation; native authority requires a separate private receipt. */
  readonly closed: Promise<void>;
  /** Reads one native chunk, observing an actual terminal rejection. */
  read(): Promise<ReadableStreamReadResult<Uint8Array>>;
  /** Requests cancellation and awaits its native retirement result. */
  cancel(reason?: unknown): Promise<void>;
  /** Releases this acquired reader's lock; it never takes a borrowed lock. */
  releaseLock(): void;
}

/**
 * Acquires one reader and observes real rejection delivery from that exact stream.
 *
 * Already-errored Web streams reject read without invoking another source pull.
 * First-party owners use this capability so retire does not report that event
 * again. A released-reader misuse cannot mark an undelivered stream fault. This
 * does not patch native stream methods or infer delivery from error identity.
 * The borrowed read/cancel methods remain authoritative for invocation. Only an
 * actual exact-native operation rejection grants stored-event delivery authority;
 * successful read-result field effects do not. Private source delivery also
 * requires the exact native getReader method invoked on this source. Borrowed
 * acquisition can select another reader and grants no original-source authority.
 * Foreign and replaced methods keep uncertain correlations as separate observations. Fields are snapshotted once
 * inside the pending read, so an acquired owner's retirement also owns their faults.
 */
export function openBytes(source: ReadableStream<Uint8Array>): ByteReaderType {
  const acquire = source.getReader;
  const reader = Reflect.apply(acquire, source, []) as ReadableStreamDefaultReader<Uint8Array>;
  const owner = owners.get(source);
  const receipt: {
    native: boolean;
    readonly bound: boolean;
    eligible: boolean;
    closed: { readonly promise: Promise<void>; readonly native: boolean } | undefined;
  } = { native: false, bound: acquire === nativeGetReader, eligible: true, closed: undefined };
  let released = false;
  const bytes: ByteReaderType = {
    get closed() {
      receipt.closed = undefined;
      // Snapshot provenance before a borrowed accessor can delete or replace
      // itself. Reflection and declared access both belong to start's rollback.
      const getter = accessor(reader, "closed");
      if (getter !== nativeClosed || nativeClosed === undefined) receipt.eligible = false;
      const declared = reader.closed;
      let native = false;
      if (nativeClosed !== undefined && getter === nativeClosed) {
        try {
          // This branded identity probe does not substitute another promise or
          // bypass the caller's access. A valid borrowed capability needs no proof.
          const state: unknown = Reflect.apply(nativeClosed, reader, []);
          // Some native getters return a rejected Promise for an incompatible
          // receiver rather than throwing. Observe this pure probe immediately
          // through the captured intrinsic, without another declared then lookup.
          // A nonidentical result is not the caller's closed/source event.
          Reflect.apply(nativeThen, state, [() => {}, () => {}]);
          native = state === declared;
        } catch { /* Native state authority is unavailable on this receiver. */ }
      }
      if (!native) receipt.eligible = false;
      receipt.closed = { promise: declared, native: native && receipt.eligible };
      return declared;
    },
    async read(): Promise<ReadableStreamReadResult<Uint8Array>> {
      let native = false;
      let next: Awaited<ReturnType<typeof reader.read>>;
      try {
        receipt.native = false;
        const declared = isNativeMethod(reader, "read", nativeRead);
        if (!declared) receipt.eligible = false;
        const read = reader.read;
        native = receipt.eligible && declared && read === nativeRead;
        if (read !== nativeRead) receipt.eligible = false;
        next = await Reflect.apply(read, reader, []);
      } catch (reason) {
        receipt.native = native;
        if (!released && receipt.bound && native) owner?.delivered();
        throw reason;
      }
      // Borrowed result getters are part of the pending read transaction.
      // Their fault is not an actual native operation rejection, and their
      // effects cannot escape again through a later field access in pull.
      const done = next.done;
      return done ? { done: true, value: next.value } : { done: false, value: next.value };
    },
    async cancel(reason) {
      let native = false;
      try {
        const declared = isNativeMethod(reader, "cancel", nativeCancel);
        if (!declared) receipt.eligible = false;
        const cancel = reader.cancel;
        native = receipt.eligible && declared && cancel === nativeCancel;
        if (cancel !== nativeCancel) receipt.eligible = false;
        await Reflect.apply(cancel, reader, [reason]);
      } catch (failure) {
        if (!released && receipt.bound && native) owner?.delivered();
        throw failure;
      }
    },
    releaseLock() {
      released = true;
      reader.releaseLock();
    },
  };
  reads.set(bytes, receipt);
  return bytes;
}

/** Exact wrapper identity owns retirement; a structural or borrowed stream does not. */
export const owners = new WeakMap<ReadableStream<Uint8Array>, AbortByteSource>();
