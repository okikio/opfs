/// <reference types="deno" />
/** Finite byte ranges own their Deno descriptor through EOF, failure or joined cancellation. @module */
import { aggregate, close } from "../../close.ts";

/** Maximum bytes retained by one finite Deno range-stream pull. */
export const RANGE_CHUNK_BYTES = 64 * 1024;

/**
 * Incrementally reads one finite range from an already-positioned Deno file.
 *
 * `Deno.FsFile.readable` reads to the end of the native file. A finite virtual
 * range needs its own remaining-byte count so it stops at the requested end.
 * Each pull allocates at most {@link RANGE_CHUNK_BYTES} bytes. The source owns
 * the file and closes it on EOF, cancellation or read failure. Cancellation
 * also joins an admitted native read before its returned promise settles.
 */
export class DenoRangeSource {
  /** Native file positioned at the first requested byte. */
  #file: Deno.FsFile | undefined;
  /** Bytes still allowed to leave this source. */
  #remaining: number;
  /** At most one admitted native read, with both outcomes observed immediately. */
  #pending:
    | Promise<{ readonly ok: true; readonly count: number | null } | { readonly ok: false; readonly reason: unknown }>
    | undefined;
  /** Already observed read outcome, used only to preserve event order at cancellation. */
  #observed:
    | { readonly ok: true; readonly count: number | null }
    | { readonly ok: false; readonly reason: unknown }
    | undefined;
  /** Consumer cancellation prevents any later controller publication. */
  #stopping = false;
  /** One terminal cancellation result, assigned before native retirement effects. */
  #cancel: Promise<void> | undefined;

  /** Takes ownership of one positioned Deno file for at most `remaining` bytes. */
  constructor(file: Deno.FsFile, remaining: number) {
    this.#file = file;
    this.#remaining = remaining;
  }

  /** Closes the native file once before the stream reaches a terminal state. */
  #close(): void {
    const file = this.#file;
    if (file === undefined) return;
    this.#file = undefined;
    file.close();
  }

  /** Reads one bounded chunk; an owned cancellation joins it without late publication. */
  async pull(controller: ReadableStreamDefaultController<Uint8Array>): Promise<void> {
    if (this.#stopping) return;
    const file = this.#file;
    if (file === undefined) {
      controller.close();
      return;
    }
    if (this.#remaining === 0) {
      this.#close();
      controller.close();
      return;
    }

    const buffer = new Uint8Array(Math.min(RANGE_CHUNK_BYTES, this.#remaining));
    // Publish pending ownership before invoking a native method that can reenter cancellation.
    const pending = Promise.resolve().then(() => file.read(buffer)).then(
      (count) => {
        const outcome = { ok: true as const, count };
        this.#observed = outcome;
        return outcome;
      },
      (reason: unknown) => {
        const outcome = { ok: false as const, reason };
        this.#observed = outcome;
        return outcome;
      },
    );
    this.#pending = pending;
    try {
      const outcome = await pending;
      if (this.#stopping) return;
      if (!outcome.ok) throw outcome.reason;
      const count = outcome.count;
      if (count === null) {
        this.#remaining = 0;
        this.#close();
        controller.close();
        return;
      }
      if (count === 0) return;

      this.#remaining -= count;
      controller.enqueue(count === buffer.byteLength ? buffer : buffer.subarray(0, count));
      if (this.#remaining === 0) {
        this.#close();
        controller.close();
      }
    } catch (error) {
      let failure = error;
      try {
        this.#close();
      } catch (reason) {
        failure = aggregate([error, reason], "Range read and native file close failed.");
      }
      controller.error(failure);
    } finally {
      if (this.#pending === pending) {
        this.#pending = undefined;
        this.#observed = undefined;
      }
    }
  }

  /**
   * Closes the descriptor, then joins the exact admitted read before cancellation settles.
   *
   * A close-induced native read rejection is actual retirement evidence. It is
   * neither discarded by error class nor published into a canceled stream. A
   * read fault already observed before cancellation retains primary position.
   */
  cancel(): Promise<void> {
    if (this.#cancel !== undefined) return this.#cancel;
    this.#stopping = true;
    this.#remaining = 0;
    const pending = this.#pending;
    const observed = this.#observed;
    const primary: readonly unknown[] = observed !== undefined && !observed.ok ? [observed.reason] : [];
    this.#cancel = Promise.resolve().then(async () => {
      await close([
        () => this.#close(),
        async () => {
          if (pending === undefined) return;
          const outcome = await pending;
          if (!outcome.ok && primary.length === 0) throw outcome.reason;
        },
      ], primary);
    });
    return this.#cancel;
  }
}
