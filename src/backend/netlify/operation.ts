/**
 * One Netlify Blobs operation and its budget.
 *
 * An operation owns its deadline, its response bodies, and a ledger of requests,
 * bytes and read steps. The client opens one per call and closes it when the
 * call ends.
 *
 * @module
 */
import { fail } from "./parse.ts";
import type { NetlifyReceiptType, NetlifyWorkType, PolicyType } from "./types.ts";
import { close } from "../../close.ts";
import { isBytes, toView } from "../../bytes.ts";
import type { FetchType } from "../../request.ts";

/** One operation owns its deadline, response bodies and finite request/byte ledger. */
export class Operation {
  readonly controller = new AbortController();
  readonly signal = this.controller.signal;
  readonly #timer: ReturnType<typeof setTimeout>;
  readonly #parent: AbortSignal | undefined;
  readonly #abort: () => void;
  readonly #policy: PolicyType;
  readonly #fetch: FetchType;
  #requests = 0;
  #bytes = 0;
  #reads = 0;
  /** Set at Fetch dispatch, when a missing reply can no longer establish that no mutation occurred. */
  mutation: { operation: "put" | "delete"; key: string } | undefined;
  /** An admitted final status survives later response admission, abort or retirement failures. */
  receipt: NetlifyReceiptType | undefined;
  constructor(fetch: FetchType, policy: PolicyType, signal?: AbortSignal) {
    this.#fetch = fetch;
    this.#policy = policy;
    this.#parent = signal;
    this.#abort = () => this.controller.abort(signal?.reason);
    signal?.throwIfAborted();
    signal?.addEventListener("abort", this.#abort, { once: true });
    this.#timer = setTimeout(
      () => this.controller.abort(new DOMException("Netlify operation deadline exceeded.", "TimeoutError")),
      policy.timeout,
    );
  }
  work(): NetlifyWorkType {
    return { requests: this.#requests, responseBytes: this.#bytes, readSteps: this.#reads };
  }
  close(): void {
    clearTimeout(this.#timer);
    this.#parent?.removeEventListener("abort", this.#abort);
  }
  async send(
    url: string,
    method: string,
    headers: Headers,
    phase: "api" | "data",
    body?: Uint8Array<ArrayBuffer>,
    mutation?: { operation: "put" | "delete"; key: string },
  ): Promise<Response> {
    this.signal.throwIfAborted();
    if (this.#requests >= this.#policy.requests) fail("budget-exceeded", phase);
    this.#requests++;
    if (mutation) this.mutation = mutation;
    // The supplied Fetch is the dispatch boundary. Hidden retries violate its contract.
    return await this.#fetch(url, {
      method,
      headers,
      redirect: "error",
      credentials: "omit",
      signal: this.signal,
      ...(body === undefined ? {} : { body }),
    });
  }
  headers(response: Response, phase: "api" | "data"): void {
    if (response.redirected) fail("invalid-response", phase, response.status);
    let length = 0;
    for (const [name, value] of response.headers) {
      length += new TextEncoder().encode(name).length + new TextEncoder().encode(value).length;
      if (length > this.#policy.headers) fail("budget-exceeded", phase, response.status);
    }
  }
  /**
   * Copy one bounded body and retire its reader before returning or rejecting.
   *
   * Read attempts share the operation ledger, so tiny and empty chunks cannot evade work admission. Growth retains
   * one accumulator instead of one object per chunk. A terminal source error is already observed; cancel only when
   * retirement still owns an active read, then preserve independent cancellation/release failures beside the primary.
   */
  async read(response: Response, maximum: number, phase: "api" | "data"): Promise<Uint8Array<ArrayBuffer>> {
    if (response.body === null) {
      this.signal.throwIfAborted();
      return new Uint8Array();
    }
    const reader = response.body.getReader();
    let output: Uint8Array<ArrayBuffer> = new Uint8Array();
    let length = 0, done = false, terminal = false, canceled: Promise<void> | undefined;
    const cancel = (reason?: unknown): Promise<void> => {
      canceled ??= Promise.resolve().then(() => reader.cancel(reason));
      void canceled.catch(() => {});
      return canceled;
    };
    const abort = (): void => {
      void cancel(this.signal.reason);
    };
    this.signal.addEventListener("abort", abort, { once: true });
    const failures: unknown[] = [];
    try {
      let empty = 0;
      while (true) {
        this.signal.throwIfAborted();
        if (this.#reads >= this.#policy.reads) fail("budget-exceeded", phase);
        this.#reads++;
        let item: ReadableStreamReadResult<Uint8Array>;
        try {
          item = await reader.read();
        } catch (error) {
          terminal = true;
          throw error;
        }
        this.signal.throwIfAborted();
        if (item.done) {
          done = true;
          break;
        }
        if (!isBytes(item.value)) fail("invalid-response", phase);
        const bytes = toView(item.value);
        if (bytes.length === 0 && ++empty > 16) fail("budget-exceeded", phase);
        if (bytes.length !== 0) empty = 0;
        const refused = bytes.length > maximum - length || bytes.length > this.#policy.response - this.#bytes;
        this.#bytes += bytes.length;
        if (refused) fail("budget-exceeded", phase);
        if (bytes.length === 0) continue;
        const needed = length + bytes.length;
        if (needed > output.length) {
          const doubled = output.length > maximum - output.length ? maximum : output.length * 2;
          const capacity = Math.min(maximum, Math.max(needed, doubled));
          const grown = new Uint8Array(capacity);
          grown.set(output);
          output = grown;
        }
        output.set(bytes, length);
        length = needed;
      }
    } catch (error) {
      failures.push(error);
    } finally {
      this.signal.removeEventListener("abort", abort);
      await close(
        [...(canceled || !done && !terminal ? [() => cancel(failures[0])] : []), () => reader.releaseLock()],
        failures,
      );
    }
    return length === output.length ? output : output.slice(0, length);
  }
  /** Retire an untouched body when status/header admission fails before read() can take ownership. */
  async response<T>(response: Response, action: () => Promise<T>): Promise<T> {
    const failures: unknown[] = [];
    try {
      return await action();
    } catch (error) {
      failures.push(error);
      throw error;
    } finally {
      if (response.body !== null && !response.body.locked && !response.bodyUsed) {
        await close([() => response.body!.cancel(failures[0])], failures);
      }
    }
  }
}
