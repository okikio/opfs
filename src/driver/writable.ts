import { toView } from "../bytes.ts";
import { FileSystemError } from "../error.ts";
import type { FileDriverWritableFileType } from "./file.ts";

/** Admission limits for one positional resource, independent of other files. */
export interface WritableOptionsType {
  /** Maximum admitted write bytes awaiting settlement. Defaults to 64 MiB. */
  readonly maxPendingBytes?: number;
  /** Maximum admitted ordinary operations awaiting settlement. Defaults to 64. */
  readonly maxPendingOperations?: number;
}

/** Detached accounting for the resource's queue and winning terminal action. */
export interface WritableInspectionType {
  /**
   * Total bytes in admitted write buffers whose operations have not settled,
   * including queued and running writes. Buffers remain borrowed from the caller
   * and must stay unchanged until their write promises settle.
   */
  readonly pendingBytes: number;
  /**
   * Number of admitted writes, truncations, and flushes awaiting settlement,
   * including queued and running operations. The terminal action has a separate
   * slot and does not contribute to this count.
   */
  readonly pendingOperations: number;
  /**
   * Configured positive safe-integer byte admission limit for this resource.
   * Defaults to 64 MiB. A write that would exceed this limit is rejected before
   * admission; the caller can await pending work before retrying.
   */
  readonly maxPendingBytes: number;
  /**
   * Configured positive safe-integer limit on pending ordinary operations for
   * this resource. Defaults to 64. Close and abort remain admissible when the
   * ordinary queue is full.
   */
  readonly maxPendingOperations: number;
  /**
   * Admission lifecycle: open accepts ordinary work; closing or aborting records
   * the first terminal action while it waits for admitted work and then settles.
   * Closed means that action settled, including rejection, rather than proving
   * that its backend cleanup or persistence succeeded.
   */
  readonly state: "open" | "closing" | "aborting" | "closed";
}

/** Validates resource policy before the caller opens a descriptor or staged writable. */
export function validateWritableOptions(options: WritableOptionsType = {}): void {
  for (const value of [options.maxPendingBytes ?? 64 * 1024 * 1024, options.maxPendingOperations ?? 64]) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new RangeError("Writable admission limits must be positive safe integers.");
    }
  }
}

/**
 * Orders complete native operations and bounds admitted buffers.
 *
 * The caller retains the buffer unchanged until its promise settles. Capacity
 * failure occurs before admission, so callers can await existing work and retry.
 * A terminal action has a separate slot: a full data queue cannot block cleanup.
 * This queue owns one resource, not application staging or path coordination.
 */
export class QueuedWritableFile implements FileDriverWritableFileType {
  readonly #file: FileDriverWritableFileType;
  readonly #maxBytes: number;
  readonly #maxOperations: number;
  #bytes = 0;
  #operations = 0;
  #tail = Promise.resolve();
  #state: WritableInspectionType["state"] = "open";
  #terminal: Promise<void> | undefined;

  constructor(file: FileDriverWritableFileType, options: WritableOptionsType = {}) {
    validateWritableOptions(options);
    this.#file = file;
    this.#maxBytes = options.maxPendingBytes ?? 64 * 1024 * 1024;
    this.#maxOperations = options.maxPendingOperations ?? 64;
    for (const value of [this.#maxBytes, this.#maxOperations]) {
      if (!Number.isSafeInteger(value) || value < 1) {
        throw new RangeError("Writable admission limits must be positive safe integers.");
      }
    }
  }

  inspect(): WritableInspectionType {
    return {
      pendingBytes: this.#bytes,
      pendingOperations: this.#operations,
      maxPendingBytes: this.#maxBytes,
      maxPendingOperations: this.#maxOperations,
      state: this.#state,
    };
  }

  /** Reserves capacity synchronously; execution starts after admitted predecessors settle. */
  #admit(bytes: number, operation: () => Promise<void>): Promise<void> {
    if (this.#state !== "open") return Promise.reject(new TypeError("Writable resource is terminating or closed."));
    if (this.#operations >= this.#maxOperations || bytes > this.#maxBytes - this.#bytes) {
      return Promise.reject(
        new FileSystemError(
          "too-large",
          "admit",
          undefined,
          "Writable admission capacity exceeded; await pending work or increase the configured resource limit before retrying.",
        ),
      );
    }
    this.#bytes += bytes;
    this.#operations += 1;
    const result = this.#tail.then(operation).finally(() => {
      this.#bytes -= bytes;
      this.#operations -= 1;
    });
    this.#tail = result.then(() => undefined, () => undefined);
    return result;
  }

  /**
   * Captures the native borrowed range before reserving queue capacity.
   * Shadowed metadata cannot bypass the byte budget or position-end admission,
   * and deferred work receives that same plain fixed-length view. Bytes remain
   * borrowed and must stay valid and unchanged until the write settles. Native
   * range conversion faults preserve this method's rejected-promise contract.
   */
  write(buffer: ArrayBufferView, options: { readonly at: number }): Promise<void> {
    let bytes: Uint8Array;
    try {
      bytes = toView(buffer);
    } catch (reason) {
      return Promise.reject(reason);
    }
    const at = options.at;
    if (!Number.isSafeInteger(at) || at < 0 || !Number.isSafeInteger(at + bytes.byteLength)) {
      return Promise.reject(new RangeError("Write position and end must be non-negative safe integers."));
    }
    return this.#admit(bytes.byteLength, () => this.#file.write(bytes, { at }));
  }

  truncate(size: number): Promise<void> {
    if (!Number.isSafeInteger(size) || size < 0) {
      return Promise.reject(new RangeError("Truncate size must be a non-negative safe integer."));
    }
    return this.#admit(0, () => this.#file.truncate(size));
  }

  flush(): Promise<void> {
    return this.#admit(0, () => this.#file.flush());
  }

  /** First terminal admission wins, including against a later opposite terminal action. */
  #finish(state: "closing" | "aborting", reason?: unknown): Promise<void> {
    if (this.#terminal !== undefined) return this.#terminal;
    this.#state = state;
    this.#terminal = this.#tail.then(() => state === "closing" ? this.#file.close() : this.#file.abort(reason))
      .finally(() => {
        this.#state = "closed";
      });
    return this.#terminal;
  }

  close(): Promise<void> {
    return this.#finish("closing");
  }
  abort(reason?: unknown): Promise<void> {
    return this.#finish("aborting", reason);
  }
}
