import { describe, it } from "node:test";
import { expect } from "@std/expect";
import { RetryError } from "@std/async/retry";

import { RequestMetrics, sendRequest } from "../src/request.ts";
import { getCancellation } from "../src/abort.ts";
import { readResponse, readText } from "../src/response.ts";
import { withReleases } from "./close.ts";
import { within } from "./gate.ts";

/** Observes each real Fetch outcome without turning duration into a timing oracle. */
class ObservedMetrics extends RequestMetrics {
  readonly outcomes: string[] = [];
  override response(started: number | undefined): void {
    this.outcomes.push("response");
    super.response(started);
  }
  override rejected(started: number | undefined): void {
    this.outcomes.push("rejected");
    super.rejected(started);
  }
}

/** Injects independent observer faults without replacing the actual Fetch owner. */
class FaultMetrics extends ObservedMetrics {
  readonly #faults: Readonly<Partial<Record<"request" | "response" | "rejected" | "failure", () => void>>>;
  constructor(faults: Readonly<Partial<Record<"request" | "response" | "rejected" | "failure", () => void>>>) {
    super();
    this.#faults = faults;
  }
  override request(retryAttempt: boolean): number | undefined {
    this.#faults.request?.();
    return super.request(retryAttempt);
  }
  override response(started: number | undefined): void {
    super.response(started);
    this.#faults.response?.();
  }
  override rejected(started: number | undefined): void {
    super.rejected(started);
    this.#faults.rejected?.();
  }
  override failure(): void {
    super.failure();
    this.#faults.failure?.();
  }
}

/** Captures an actual rejection independently from successful undefined resolution. */
async function rejectedResponse(action: Promise<unknown>): Promise<unknown> {
  try {
    await action;
  } catch (reason) {
    return reason;
  }
  throw new Error("Expected an owned retry response to fail.");
}

/** Stable URL used by request-policy tests without opening a real network connection. */
const TEST_URL = new URL("https://storage.example/object");

describe("owned response text", () => {
  it("keeps UTF-8 replacement and BOM semantics across every split of authored bytes", async () => {
    class Bytes extends Uint8Array {}
    const bytes = new Uint8Array([239, 187, 191, 65, 240, 159, 152, 128, 195, 169, 255]);
    for (let cut = 0; cut <= bytes.length; cut++) {
      const padded = new Bytes(bytes.length + 4);
      padded.set(bytes, 2);
      const chunks = [padded.subarray(2, 2 + cut), padded.subarray(2 + cut, 2 + bytes.length)];
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          for (const chunk of chunks) controller.enqueue(chunk);
          controller.close();
        },
      });
      expect(await readText(new Response(body))).toBe("A😀é�");
      expect(body.locked).toBe(false);
    }
  });

  for (
    const scenario of [
      { name: "double initial BOM", bytes: [239, 187, 191, 239, 187, 191, 65], expected: "\uFEFFA" },
      { name: "middle BOM", bytes: [65, 239, 187, 191, 66], expected: "A\uFEFFB" },
      { name: "truncated multibyte sequence", bytes: [65, 240, 159], expected: "A�" },
    ]
  ) {
    it(`keeps whole UTF-8 semantics for ${scenario.name} across every split and empty chunks`, async () => {
      const bytes = new Uint8Array(scenario.bytes);
      for (let cut = 0; cut <= bytes.length; cut++) {
        const chunks = [
          new Uint8Array(),
          bytes.subarray(0, cut),
          new Uint8Array(),
          bytes.subarray(cut),
          new Uint8Array(),
        ];
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            for (const chunk of chunks) controller.enqueue(chunk);
            controller.close();
          },
        });
        expect(await readText(new Response(body))).toBe(scenario.expected);
        expect(body.locked).toBe(false);
      }
    });
  }

  it("cancels a header-only response without materializing its body", async () => {
    let reads = 0;
    let cancellations = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        reads++;
        controller.enqueue(new Uint8Array([65]));
        controller.close();
      },
      cancel() {
        cancellations++;
      },
    }, { highWaterMark: 0 });
    expect(await readResponse(new Response(body), () => "header")).toBe("header");
    expect(reads).toBe(0);
    expect(cancellations).toBe(1);
    expect(body.locked).toBe(false);
  });

  for (const fault of [undefined, null, new Error("Authored terminal text fault.")]) {
    for (const phase of ["start", "mid-read"] as const) {
      it(`retains an actual ${phase} text fault and releases its reader (${String(fault)})`, async () => {
        let pulls = 0;
        let cancellations = 0;
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            if (phase === "start") controller.error(fault);
          },
          pull(controller) {
            if (pulls++ === 0) controller.enqueue(new Uint8Array([65]));
            else controller.error(fault);
          },
          cancel() {
            cancellations++;
          },
        }, { highWaterMark: 0 });
        expect(await rejectedResponse(readText(new Response(body)))).toBe(fault);
        expect(body.locked).toBe(false);
        expect(cancellations).toBe(0);
      });
    }

    it(`keeps an awaited and classified read fault as one event (${String(fault)})`, async () => {
      const classified = new Error("Authored classified response failure.", { cause: fault });
      let cancellations = 0;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.error(fault);
        },
        cancel() {
          cancellations++;
        },
      });
      const reason = await rejectedResponse(readResponse(new Response(body), async (text) => {
        try {
          await text();
        } catch (read) {
          expect(read).toBe(fault);
          throw classified;
        }
      }));
      expect(reason).toBe(classified);
      expect(classified.cause).toBe(fault);
      expect(body.locked).toBe(false);
      expect(cancellations).toBe(0);
    });
  }

  it("drains an ignored read after early callback failure and retains same-object independent events", async () => {
    await withReleases(async (releases) => {
      const fault = new Error("Authored independent callback and reader faults.");
      const admitted = Promise.withResolvers<ReadableStreamDefaultController<Uint8Array>>();
      let source: ReadableStreamDefaultController<Uint8Array> | undefined;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          source = controller;
        },
        pull(controller) {
          admitted.resolve(controller);
        },
      }, {
        highWaterMark: 0,
      });
      const owner = source;
      if (owner === undefined) throw new Error("The native source did not start.");
      let settled = false;
      const pending = rejectedResponse(readResponse(new Response(body), (text) => {
        void text();
        throw fault;
      })).then((reason) => {
        settled = true;
        return reason;
      });
      releases.push(() => pending);
      releases.push(() => owner.error(fault));
      const controller = await within(admitted.promise, "ignored owned text reader admission");
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      expect(settled).toBe(false);
      expect(body.locked).toBe(true);
      controller.error(fault);
      const reason = await within(pending, "ignored owned text reader settlement");
      if (!(reason instanceof AggregateError)) throw new Error("Expected independent callback and reader faults.");
      expect(reason.errors).toHaveLength(2);
      expect(reason.errors[0]).toBe(fault);
      expect(reason.errors[1]).toBe(fault);
      expect(reason.cause).toBe(fault);
      expect(body.locked).toBe(false);
    });
  });

  it("keeps an unread failure authoritative when a detached handler runs after callback settlement", async () => {
    await withReleases(async (releases) => {
      const fault = new Error("Actual held response read failure.");
      const admitted = Promise.withResolvers<ReadableStreamDefaultController<Uint8Array>>();
      const observed = Promise.withResolvers<unknown>();
      const callback = Promise.withResolvers<void>();
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          admitted.resolve(controller);
        },
      }, { highWaterMark: 0 });
      let settled = false;
      const pending = rejectedResponse(readResponse(new Response(body), (text) => {
        void text().then(undefined, (reason) => {
          observed.resolve(reason);
        });
        callback.resolve();
        return "header acknowledgement";
      })).finally(() => {
        settled = true;
      });
      const controller = await within(admitted.promise, "detached response read admission");
      releases.push(() => pending);
      releases.push(() => controller.error(fault));
      await callback.promise;
      // The native read is held, so the callback has returned while ownership
      // remains pending. A later catch is observational, not its classification.
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      expect(settled).toBe(false);
      expect(body.locked).toBe(true);
      controller.error(fault);
      expect(await within(observed.promise, "detached read observation")).toBe(fault);
      expect(await within(pending, "owned detached read failure")).toBe(fault);
      expect(body.locked).toBe(false);
    });
  });

  it("retains same-object callback and header retirement failures independently", async () => {
    const fault = new Error("Authored independent header and disposal faults.");
    const response = new Response(
      new ReadableStream<Uint8Array>({
        cancel() {
          throw fault;
        },
      }),
    );
    const reason = await rejectedResponse(readResponse(response, () => {
      throw fault;
    }));
    if (!(reason instanceof AggregateError)) throw new Error("Expected independent callback and retirement faults.");
    expect(reason.errors).toHaveLength(2);
    expect(reason.errors[0]).toBe(fault);
    expect(reason.errors[1]).toBe(fault);
  });

  it("keeps actual read and independent reader release faults", async () => {
    const read = new Error("Authored stream read failure.");
    const release = new Error("Authored reader release failure.");
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(read);
      },
    });
    const acquire = body.getReader.bind(body);
    Object.defineProperty(body, "getReader", {
      value() {
        const reader = acquire();
        const unlock = reader.releaseLock.bind(reader);
        reader.releaseLock = () => {
          unlock();
          throw release;
        };
        return reader;
      },
    });
    const reason = await rejectedResponse(readResponse(new Response(body), async (text) => await text()));
    if (!(reason instanceof AggregateError)) throw new Error("Expected independent read and release faults.");
    expect(reason.errors).toHaveLength(2);
    expect(reason.errors[0]).toBe(read);
    expect(reason.errors[1]).toBe(release);
    expect(body.locked).toBe(false);
  });

  it("awaits failed conversion cleanup and keeps cancel and release as independent events", async () => {
    await withReleases(async (releases) => {
      const disposal = new Error("Authored independent source and reader cleanup faults.");
      const admitted = Promise.withResolvers<void>();
      const finish = Promise.withResolvers<void>();
      let cancellations = 0;
      let settled = false;
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          controller.enqueue(new Proxy(new Uint8Array([65]), {}));
        },
        async cancel() {
          cancellations++;
          admitted.resolve();
          await finish.promise;
          throw disposal;
        },
      }, { highWaterMark: 0 });
      const acquire = body.getReader.bind(body);
      Object.defineProperty(body, "getReader", {
        value() {
          const reader = acquire();
          const unlock = reader.releaseLock.bind(reader);
          reader.releaseLock = () => {
            unlock();
            throw disposal;
          };
          return reader;
        },
      });
      const pending = rejectedResponse(readResponse(new Response(body), async (text) => await text()))
        .then((reason) => {
          settled = true;
          return reason;
        });
      releases.push(() => pending);
      releases.push(() => finish.resolve());
      await within(admitted.promise, "conversion cancellation admission");
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      expect(settled).toBe(false);
      expect(body.locked).toBe(true);
      finish.resolve();
      const reason = await within(pending, "conversion cancellation settlement");
      if (!(reason instanceof AggregateError)) throw new Error("Expected conversion and cleanup faults.");
      expect(reason.errors).toHaveLength(3);
      expect(reason.errors[0]).toBeInstanceOf(TypeError);
      expect(reason.errors[1]).toBe(disposal);
      expect(reason.errors[2]).toBe(disposal);
      expect(cancellations).toBe(1);
      expect(body.locked).toBe(false);
    });
  });

  for (const failed of [false, true]) {
    it(`refuses a header-only borrowed lock and retains callback failure (${failed})`, async () => {
      await withReleases(async (releases) => {
        const callback = new Error("Authored independent header callback failure.");
        let cancellations = 0;
        const body = new ReadableStream<Uint8Array>({
          cancel() {
            cancellations++;
          },
        }, { highWaterMark: 0 });
        const response = new Response(body);
        const borrowed = body.getReader();
        releases.push(() => borrowed.releaseLock());
        releases.push(() => borrowed.cancel());
        const reason = await rejectedResponse(readResponse(response, () => {
          if (failed) throw callback;
          return "header";
        }));
        if (failed) {
          if (!(reason instanceof AggregateError)) {
            throw new Error("Expected callback and independent retirement refusal.");
          }
          expect(reason.errors).toHaveLength(2);
          expect(reason.errors[0]).toBe(callback);
          expect(reason.errors[1]).toBeInstanceOf(TypeError);
          expect(reason.cause).toBe(callback);
        } else {
          expect(reason).toBeInstanceOf(TypeError);
        }
        expect(body.locked).toBe(true);
        expect(cancellations).toBe(0);
      });
    });
  }

  it("awaits cancellation of a disturbed body after its partial reader releases the lock", async () => {
    await withReleases(async (releases) => {
      const admitted = Promise.withResolvers<void>();
      const finish = Promise.withResolvers<void>();
      let cancellations = 0;
      let settled = false;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array([65]));
        },
        async cancel() {
          cancellations++;
          admitted.resolve();
          await finish.promise;
        },
      }, { highWaterMark: 0 });
      const response = new Response(body);
      releases.push(async () => {
        finish.resolve();
        await body.cancel();
      });
      const partial = body.getReader();
      try {
        const chunk = await partial.read();
        expect(chunk.done).toBe(false);
        expect(chunk.value).toEqual(new Uint8Array([65]));
      } finally {
        partial.releaseLock();
      }
      expect(response.bodyUsed).toBe(true);
      expect(body.locked).toBe(false);
      const pending = readResponse(response, () => "header").finally(() => {
        settled = true;
      });
      releases.push(() => pending);
      // Release before draining pending on every failing assertion/admission.
      releases.push(() => finish.resolve());
      await within(admitted.promise, "disturbed response cancellation admission");
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      expect(settled).toBe(false);
      finish.resolve();
      expect(await within(pending, "disturbed response cancellation settlement")).toBe("header");
      expect(cancellations).toBe(1);
      expect(body.locked).toBe(false);
    });
  });

  it("refuses retirement when a callback recovers from borrowed text acquisition", async () => {
    await withReleases(async (releases) => {
      let cancellations = 0;
      let recovered = false;
      const body = new ReadableStream<Uint8Array>({
        cancel() {
          cancellations++;
        },
      }, { highWaterMark: 0 });
      const response = new Response(body);
      const borrowed = body.getReader();
      releases.push(() => borrowed.releaseLock());
      releases.push(() => borrowed.cancel());
      const reason = await rejectedResponse(readResponse(response, async (text) => {
        try {
          await text();
        } catch (failure) {
          expect(failure).toBeInstanceOf(TypeError);
          recovered = true;
        }
        return "header";
      }));
      expect(recovered).toBe(true);
      expect(reason).toBeInstanceOf(TypeError);
      expect(body.locked).toBe(true);
      expect(cancellations).toBe(0);
    });
  });

  it("does not retire a borrowed reader after failed acquisition", async () => {
    await withReleases(async (releases) => {
      let cancellations = 0;
      const body = new ReadableStream<Uint8Array>({
        cancel() {
          cancellations++;
        },
      }, { highWaterMark: 0 });
      const response = new Response(body);
      const borrowed = body.getReader();
      releases.push(() => borrowed.releaseLock());
      releases.push(() => borrowed.cancel());
      const reason = await rejectedResponse(readResponse(response, async (text) => await text()));
      expect(reason).toBeInstanceOf(TypeError);
      expect(body.locked).toBe(true);
      expect(cancellations).toBe(0);
    });
  });
});

describe("request policy", () => {
  it("owns an acquired response until a failed observer's delayed disposal settles", async () => {
    await withReleases(async (releases) => {
      const observer = new Error("Authored response observer failure.");
      const admitted = Promise.withResolvers<void>();
      const finish = Promise.withResolvers<void>();
      let requests = 0;
      let cancellations = 0;
      let settled = false;
      const metrics = new FaultMetrics({
        response() {
          throw observer;
        },
      });
      const pending = rejectedResponse(sendRequest(async () => ({ input: TEST_URL }), {
        fetch: async () => {
          requests++;
          return new Response(
            new ReadableStream<Uint8Array>({
              async cancel() {
                cancellations++;
                admitted.resolve();
                await finish.promise;
              },
            }, { highWaterMark: 0 }),
          );
        },
        policy: { retries: 3, minDelayMs: 0, maxDelayMs: 0, jitter: 0 },
        metrics,
      })).then((reason) => {
        settled = true;
        return reason;
      });
      releases.push(() => pending);
      releases.push(() => finish.resolve());
      await within(admitted.promise, "observer response disposal admission");
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      expect(settled).toBe(false);
      expect(requests).toBe(1);
      expect(cancellations).toBe(1);
      finish.resolve();
      expect(await within(pending, "observer response disposal settlement")).toBe(observer);
      expect(metrics.outcomes).toEqual(["response"]);
      expect(metrics.snapshot()).toMatchObject({ requests: 1, responses: 1, failures: 1, retries: 0 });
    });
  });

  for (const observer of [undefined, null, new Error("Authored metrics observer fault.")]) {
    it(`retains response observer and independent disposal faults (${String(observer)})`, async () => {
      const disposal = new Error("Authored observer response disposal fault.");
      let requests = 0;
      let cancellations = 0;
      const metrics = new FaultMetrics({
        response() {
          throw observer;
        },
      });
      const reason = await rejectedResponse(sendRequest(async () => ({ input: TEST_URL }), {
        fetch: async () => {
          requests++;
          return new Response(
            new ReadableStream<Uint8Array>({
              cancel() {
                cancellations++;
                throw disposal;
              },
            }),
          );
        },
        policy: { retries: 2, minDelayMs: 0, maxDelayMs: 0, jitter: 0 },
        metrics,
      }));
      if (!(reason instanceof AggregateError)) throw new Error("Expected observer and disposal faults.");
      expect(reason.errors).toHaveLength(2);
      expect(reason.errors[0]).toBe(observer);
      expect(reason.errors[1]).toBe(disposal);
      expect(reason.cause).toBe(observer);
      expect(cancellations).toBe(1);
      expect(requests).toBe(1);
      expect(metrics.outcomes).toEqual(["response"]);
    });

    it(`retains actual Fetch failure before its rejection observer fault (${String(observer)})`, async () => {
      const transport = new TypeError("Authored Fetch rejection.");
      let requests = 0;
      const metrics = new FaultMetrics({
        rejected() {
          throw observer;
        },
      });
      const reason = await rejectedResponse(sendRequest(async () => ({ input: TEST_URL }), {
        fetch: async () => {
          requests++;
          throw transport;
        },
        policy: { retries: 2, minDelayMs: 0, maxDelayMs: 0, jitter: 0 },
        metrics,
      }));
      if (!(reason instanceof AggregateError)) throw new Error("Expected Fetch and observer faults.");
      expect(reason.errors).toHaveLength(2);
      expect(reason.errors[0]).toBe(transport);
      expect(reason.errors[1]).toBe(observer);
      expect(reason.cause).toBe(transport);
      expect(requests).toBe(1);
      expect(metrics.outcomes).toEqual(["rejected"]);
    });

    it(`retains an exhausted Fetch reason before its terminal observer fault (${String(observer)})`, async () => {
      const metrics = new FaultMetrics({
        failure() {
          throw observer;
        },
      });
      let requests = 0;
      const reason = await rejectedResponse(sendRequest(async () => ({ input: TEST_URL }), {
        fetch: async () => {
          requests++;
          throw null;
        },
        policy: { retries: 1, minDelayMs: 0, maxDelayMs: 0, jitter: 0 },
        metrics,
      }));
      if (!(reason instanceof AggregateError)) throw new Error("Expected terminal and observer faults.");
      expect(reason.errors).toHaveLength(2);
      expect(reason.errors[0]).toBe(null);
      expect(reason.errors[1]).toBe(observer);
      expect(reason.cause).toBe(null);
      expect(requests).toBe(2);
      expect(metrics.outcomes).toEqual(["rejected", "rejected"]);
    });

    it(`refuses Fetch effects after a request observer throws (${String(observer)})`, async () => {
      let preparations = 0;
      let requests = 0;
      const metrics = new FaultMetrics({
        request() {
          throw observer;
        },
      });
      const reason = await rejectedResponse(sendRequest(async () => {
        preparations++;
        return { input: TEST_URL };
      }, {
        fetch: async () => {
          requests++;
          return new Response(null);
        },
        policy: { retries: 2, minDelayMs: 0, maxDelayMs: 0, jitter: 0 },
        metrics,
      }));
      expect(reason).toBe(observer);
      expect(preparations).toBe(1);
      expect(requests).toBe(0);
      expect(metrics.snapshot()).toMatchObject({ requests: 0, failures: 1, responses: 0 });
    });
  }

  for (const callback of ["create", "input", "request", "response"] as const) {
    it(`refuses borrowed HTTP retry authority thrown from ${callback}`, async () => {
      // Obtain a real private HTTP marker through a previous owned operation's
      // public aggregate, instead of importing or manufacturing its class.
      const previous = await rejectedResponse(sendRequest(async () => ({ input: TEST_URL }), {
        fetch: async () =>
          new Response(
            new ReadableStream<Uint8Array>({
              cancel() {
                throw null;
              },
            }),
            { status: 503 },
          ),
        policy: { retries: 1, minDelayMs: 0, maxDelayMs: 0, jitter: 0 },
      }));
      if (!(previous instanceof AggregateError)) throw new Error("Expected the previous actual HTTP retry reason.");
      const borrowed: unknown = previous.errors[0];
      let preparations = 0;
      let requests = 0;
      let cancellations = 0;
      const metrics = new FaultMetrics({
        ...(callback === "request"
          ? {
            request() {
              throw borrowed;
            },
          }
          : {}),
        ...(callback === "response"
          ? {
            response() {
              throw borrowed;
            },
          }
          : {}),
      });
      const reason = await rejectedResponse(sendRequest(async () => {
        preparations++;
        if (callback === "create") throw borrowed;
        if (callback === "input") {
          return {
            get input(): URL {
              throw borrowed;
            },
          };
        }
        return { input: TEST_URL };
      }, {
        fetch: async () => {
          requests++;
          return new Response(
            new ReadableStream<Uint8Array>({
              cancel() {
                cancellations++;
              },
            }),
          );
        },
        policy: { retries: 3, minDelayMs: 0, maxDelayMs: 0, jitter: 0 },
        metrics,
      }));
      expect(reason).toBe(borrowed);
      expect(preparations).toBe(1);
      expect(requests).toBe(callback === "response" ? 1 : 0);
      expect(cancellations).toBe(callback === "response" ? 1 : 0);
    });
  }

  it("preserves an externally supplied retry-engine error as a sole preparation reason", async () => {
    const foreign = new RetryError(new Error("Authored external retry cause."), 2);
    let preparations = 0;
    let requests = 0;
    const reason = await rejectedResponse(sendRequest(async () => {
      preparations++;
      throw foreign;
    }, {
      fetch: async () => {
        requests++;
        return new Response(null);
      },
      policy: { retries: 2, minDelayMs: 0, maxDelayMs: 0, jitter: 0 },
    }));
    expect(reason).toBe(foreign);
    expect(preparations).toBe(1);
    expect(requests).toBe(0);
  });

  for (const primary of [undefined, null]) {
    it(`preserves a sole exhausted transport rejection (${String(primary)})`, async () => {
      let requests = 0;
      const reason = await rejectedResponse(sendRequest(async () => ({ input: TEST_URL }), {
        fetch: async () => {
          requests++;
          throw primary;
        },
        policy: { retries: 1, minDelayMs: 0, maxDelayMs: 0, jitter: 0 },
      }));
      expect(reason).toBe(primary);
      expect(requests).toBe(2);
    });

    it(`preserves caller cancellation during pending preparation (${String(primary)})`, async () => {
      await withReleases(async (releases) => {
        const controller = new AbortController();
        const admitted = Promise.withResolvers<void>();
        const finish = Promise.withResolvers<void>();
        let preparations = 0;
        let requests = 0;
        const pending = rejectedResponse(sendRequest(async () => {
          preparations++;
          admitted.resolve();
          await finish.promise;
          return { input: TEST_URL };
        }, {
          fetch: async () => {
            requests++;
            return new Response(null);
          },
          signal: controller.signal,
          policy: { retries: 2, minDelayMs: 0, maxDelayMs: 0, jitter: 0 },
        }));
        releases.push(() => pending);
        releases.push(() => finish.resolve());
        releases.push(() => controller.abort(primary));
        await within(admitted.promise, "pending credential acquisition");
        controller.abort(primary);
        expect(await within(pending, "caller cancellation during preparation")).toBe(controller.signal.reason);
        finish.resolve();
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        expect(preparations).toBe(1);
        expect(requests).toBe(0);
      });
    });
  }

  for (const phase of ["create", "fetch"] as const) {
    it(`retains a settled ${phase} fault and independent caller cancellation`, async () => {
      const controller = new AbortController();
      const original = new Error("Authored settled operation failure.");
      let preparations = 0;
      let requests = 0;
      const reason = await rejectedResponse(sendRequest(async () => {
        preparations++;
        if (phase === "create") {
          controller.abort(null);
          throw original;
        }
        return { input: TEST_URL };
      }, {
        fetch: async () => {
          requests++;
          controller.abort(null);
          throw original;
        },
        signal: controller.signal,
        policy: { retries: 2, minDelayMs: 0, maxDelayMs: 0, jitter: 0 },
      }));
      if (!(reason instanceof AggregateError)) {
        throw new Error("Expected settled failure and independent cancellation.");
      }
      expect(reason.errors).toHaveLength(2);
      expect(reason.errors[0]).toBe(original);
      expect(reason.errors[1]).toBe(controller.signal.reason);
      expect(reason.cause).toBe(original);
      expect(preparations).toBe(1);
      expect(requests).toBe(phase === "fetch" ? 1 : 0);
    });
  }

  it("awaits intermediate response retirement before retry and transfers the final body", async () => {
    await withReleases(async (releases) => {
      const admitted = Promise.withResolvers<void>();
      const finish = Promise.withResolvers<void>();
      let requests = 0;
      let finalCancellations = 0;
      const pending = sendRequest(async () => ({ input: TEST_URL }), {
        fetch: async () => {
          requests++;
          if (requests === 1) {
            return new Response(
              new ReadableStream<Uint8Array>({
                async cancel() {
                  admitted.resolve();
                  await finish.promise;
                },
              }, { highWaterMark: 0 }),
              { status: 503 },
            );
          }
          return new Response(
            new ReadableStream<Uint8Array>({
              cancel() {
                finalCancellations++;
              },
            }, { highWaterMark: 0 }),
          );
        },
        policy: { retries: 1, minDelayMs: 0, maxDelayMs: 0, jitter: 0 },
      });
      releases.push(async () => (await pending).body?.cancel());
      releases.push(() => finish.resolve());
      await within(admitted.promise, "retry response retirement admission");
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      expect(requests).toBe(1);
      finish.resolve();
      const final = await pending;
      expect(requests).toBe(2);
      expect(finalCancellations).toBe(0);
      await final.body?.cancel();
      expect(finalCancellations).toBe(1);
    });
  });

  for (const disposal of [undefined, null, new Error("Authored retry body disposal failure.")]) {
    it(`refuses a retry after independent body disposal failure (${String(disposal)})`, async () => {
      let requests = 0;
      const metrics = new ObservedMetrics();
      const response = new Response(
        new ReadableStream<Uint8Array>({
          cancel() {
            throw disposal;
          },
        }),
        { status: 503 },
      );
      const observed = await rejectedResponse(sendRequest(async () => ({ input: TEST_URL }), {
        fetch: async () => {
          requests++;
          return response;
        },
        policy: { retries: 3, minDelayMs: 0, maxDelayMs: 0, jitter: 0 },
        metrics,
      }));
      if (!(observed instanceof AggregateError)) throw new Error("Expected independent response failures.");
      const primary = observed.errors[0];
      if (!(primary instanceof Error)) throw new Error("Expected the actual HTTP retry reason.");
      expect(Reflect.get(primary, "response")).toBe(response);
      expect(observed.errors[1]).toBe(disposal);
      expect(observed.cause).toBe(observed.errors[0]);
      expect(requests).toBe(1);
      expect(metrics.outcomes).toEqual(["response"]);
      expect(metrics.snapshot()).toMatchObject({ requests: 1, responses: 1, retries: 0, failures: 1 });
    });
  }

  it("an attempt timeout during disposal cannot erase that fault or admit a retry", async () => {
    const disposal = new Error("Disposal failed after its request signal expired.");
    let requests = 0;
    let expired = false;
    const metrics = new ObservedMetrics();
    const observed = await within(
      rejectedResponse(sendRequest(async (signal) => ({
        input: TEST_URL,
        init: { ...(signal === undefined ? {} : { signal }) },
      }), {
        fetch: async (_input, init) => {
          requests++;
          if (requests > 1) return new Response(null);
          const signal = init?.signal;
          if (signal === undefined || signal === null) throw new Error("Expected the prepared attempt signal.");
          return new Response(
            new ReadableStream<Uint8Array>({
              cancel() {
                return new Promise<void>((_resolve, reject) => {
                  const fail = () => {
                    expired = true;
                    reject(disposal);
                  };
                  if (signal.aborted) fail();
                  else signal.addEventListener("abort", fail, { once: true });
                });
              },
            }, { highWaterMark: 0 }),
            { status: 503 },
          );
        },
        policy: { retries: 1, timeoutMs: 10, minDelayMs: 0, maxDelayMs: 0, jitter: 0 },
        metrics,
      })),
      "expired retry response retirement",
    );
    if (!(observed instanceof AggregateError)) throw new Error("Expected independent response failures.");
    expect(observed.errors[0]).toMatchObject({ response: { status: 503 } });
    expect(observed.errors[1]).toBe(disposal);
    expect(expired).toBe(true);
    expect(requests).toBe(1);
    expect(metrics.outcomes).toEqual(["response"]);
  });

  it("supports a zero-delay retry policy without violating @std/async validation", async () => {
    let fetches = 0;
    const metrics = new RequestMetrics();
    const response = await sendRequest(
      async () => ({ input: TEST_URL }),
      {
        fetch: async () => {
          fetches += 1;
          return new Response(null, { status: fetches === 1 ? 503 : 200 });
        },
        policy: { retries: 1, minDelayMs: 0, maxDelayMs: 0, jitter: 0 },
        metrics,
      },
    );

    expect(response.status).toBe(200);
    expect(fetches).toBe(2);
    expect(metrics.snapshot()).toMatchObject({ requests: 2, retries: 1, failures: 0, responses: 2 });
  });

  it("bypasses the retry engine for an explicitly single-attempt request", async () => {
    let fetches = 0;
    const response = await sendRequest(
      async () => ({ input: TEST_URL }),
      {
        fetch: async () => {
          fetches += 1;
          return new Response(null, { status: 503 });
        },
        policy: { retries: 5, minDelayMs: 0, maxDelayMs: 0, jitter: 0 },
        replayable: false,
      },
    );

    expect(response.status).toBe(503);
    expect(fetches).toBe(1);
  });

  it("does not count or retry deterministic request preparation failures", async () => {
    const metrics = new RequestMetrics();
    let fetches = 0;
    let preparations = 0;
    const reason = new TypeError("invalid signing input");

    await expect(sendRequest(
      async () => {
        preparations += 1;
        throw reason;
      },
      {
        fetch: async () => {
          fetches += 1;
          return new Response(null, { status: 200 });
        },
        policy: { retries: 4, minDelayMs: 0, maxDelayMs: 0, jitter: 0 },
        metrics,
      },
    )).rejects.toBe(reason);

    expect(preparations).toBe(1);
    expect(fetches).toBe(0);
    expect(metrics.snapshot()).toMatchObject({ requests: 0, retries: 0, failures: 1, responses: 0 });
  });

  it("retries a transport failure and returns the next response", async () => {
    const metrics = new RequestMetrics();
    let fetches = 0;

    const response = await sendRequest(
      async () => ({ input: TEST_URL }),
      {
        fetch: async () => {
          fetches += 1;
          if (fetches === 1) throw new TypeError("temporary network failure");
          return new Response(null, { status: 200 });
        },
        policy: { retries: 1, minDelayMs: 0, maxDelayMs: 0, jitter: 0 },
        metrics,
      },
    );

    expect(response.status).toBe(200);
    expect(fetches).toBe(2);
    expect(metrics.snapshot()).toMatchObject({ requests: 2, retries: 1, failures: 0, responses: 1 });
  });

  it("retries an attempt timeout during preparation without inventing an HTTP retry", async () => {
    const metrics = new RequestMetrics();
    let preparations = 0;
    let fetches = 0;

    const response = await sendRequest(
      async (signal) => {
        preparations += 1;
        if (preparations === 1) {
          await new Promise<never>((_resolve, reject) => {
            signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
          });
        }
        return { input: TEST_URL };
      },
      {
        fetch: async () => {
          fetches += 1;
          return new Response(null, { status: 200 });
        },
        policy: { retries: 1, minDelayMs: 0, maxDelayMs: 0, jitter: 0, timeoutMs: 5 },
        metrics,
      },
    );

    expect(response.status).toBe(200);
    expect(preparations).toBe(2);
    expect(fetches).toBe(1);
    expect(metrics.snapshot()).toMatchObject({ requests: 1, retries: 0, failures: 0, responses: 1 });
  });

  it("treats caller cancellation as authoritative and does not retry it", async () => {
    const controller = new AbortController();
    controller.abort(new DOMException("caller stopped request", "AbortError"));
    let preparations = 0;
    let fetches = 0;

    await expect(sendRequest(
      async () => {
        preparations += 1;
        return { input: TEST_URL };
      },
      {
        fetch: async () => {
          fetches += 1;
          return new Response(null, { status: 200 });
        },
        signal: controller.signal,
        policy: { retries: 4, minDelayMs: 0, maxDelayMs: 0, jitter: 0 },
      },
    )).rejects.toMatchObject({ name: "AbortError" });

    expect(preparations).toBe(0);
    expect(fetches).toBe(0);
  });
});

describe("request cancellation event authority", () => {
  for (const phase of ["create", "fetch"] as const) {
    for (const value of [null, new Error("Authored same-valued operation and abort observations")]) {
      it(`retains both equal-valued ${phase} rejection and caller event`, async () => {
        const caller = new AbortController();
        let requests = 0;
        let preparations = 0;
        const reason = await rejectedResponse(sendRequest(async () => {
          preparations++;
          if (phase === "create") {
            caller.abort(value);
            throw value;
          }
          return { input: TEST_URL };
        }, {
          signal: caller.signal,
          fetch: async () => {
            requests++;
            caller.abort(value);
            throw value;
          },
          policy: { retries: 2, minDelayMs: 0, maxDelayMs: 0, jitter: 0 },
        }));
        if (!(reason instanceof AggregateError)) throw reason;
        expect(reason.errors).toHaveLength(2);
        expect(reason.errors[0]).toBe(value);
        expect(reason.errors[1]).toBe(value);
        expect(reason.cause).toBe(value);
        const observation = getCancellation(reason);
        expect(observation).toEqual({
          signal: caller.signal,
          reason: value,
          primary: { kind: "operation", stage: phase === "create" ? "prepare" : "fetch", reason: value },
          extra: [],
        });
        expect(Object.isFrozen(observation)).toBe(true);
        expect(Object.isFrozen(observation?.primary)).toBe(true);
        expect(Object.isFrozen(observation?.extra)).toBe(true);
        expect(getCancellation(new AggregateError(reason.errors, "Borrowed shape", { cause: value }))).toBeUndefined();
        expect(preparations).toBe(1);
        expect(requests).toBe(phase === "fetch" ? 1 : 0);
      });
    }
  }

  it("keeps an actual preparation abort winner scalar and never tags its borrowed reason", async () => {
    await withReleases(async (releases) => {
      const caller = new AbortController();
      const admitted = Promise.withResolvers<void>();
      const finish = Promise.withResolvers<void>();
      const value = new AggregateError([null], "Authored caller value");
      let requests = 0;
      const pending = rejectedResponse(sendRequest(async () => {
        admitted.resolve();
        await finish.promise;
        return { input: TEST_URL };
      }, {
        signal: caller.signal,
        fetch: async () => {
          requests++;
          return new Response(null);
        },
        policy: { retries: 2, minDelayMs: 0, maxDelayMs: 0, jitter: 0 },
      }));
      releases.push(() => pending);
      releases.push(() => finish.resolve());
      releases.push(() => caller.abort(value));
      await within(admitted.promise, "tagged preparation ownership");
      caller.abort(value);
      expect(await within(pending, "owned scalar abort winner")).toBe(value);
      expect(getCancellation(value)).toBeUndefined();
      finish.resolve();
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      expect(requests).toBe(0);
    });
  });

  for (const stage of ["rejected", "failure"] as const) {
    it(`retains an extra ${stage} observer fault beside caller evidence`, async () => {
      const caller = new AbortController();
      const value = new Error("Authored forwarded caller reason");
      const observer = new Error("Authored independent observer fault");
      const metrics = new FaultMetrics({
        [stage]() {
          throw observer;
        },
      });
      const reason = await rejectedResponse(sendRequest(async () => ({ input: TEST_URL }), {
        signal: caller.signal,
        metrics,
        replayable: false,
        fetch: async () => {
          caller.abort(value);
          throw value;
        },
      }));
      if (!(reason instanceof AggregateError)) throw reason;
      expect(reason.errors).toHaveLength(2);
      expect(reason.errors[1]).toBe(observer);
      const observed = getCancellation(reason);
      expect(observed?.signal).toBe(caller.signal);
      expect(observed?.reason).toBe(value);
      expect(observed?.primary).toEqual({ kind: "operation", stage: "fetch", reason: value });
      expect(observed?.extra).toEqual([observer]);
    });
  }

  it("keeps abort-winning preparation primary when its terminal observer also fails", async () => {
    await withReleases(async (releases) => {
      const caller = new AbortController();
      const admitted = Promise.withResolvers<void>();
      const finish = Promise.withResolvers<void>();
      const observer = new Error("Authored abort observer fault");
      const pending = rejectedResponse(sendRequest(async () => {
        admitted.resolve();
        await finish.promise;
        return { input: TEST_URL };
      }, {
        signal: caller.signal,
        replayable: false,
        fetch: async () => {
          throw new Error("An aborted preparation cannot dispatch");
        },
        metrics: new FaultMetrics({
          failure() {
            throw observer;
          },
        }),
      }));
      releases.push(() => pending);
      releases.push(() => finish.resolve());
      releases.push(() => caller.abort(null));
      await within(admitted.promise, "abort primary preparation");
      caller.abort(null);
      const reason = await within(pending, "abort primary observer settlement");
      if (!(reason instanceof AggregateError)) throw reason;
      expect(reason.errors).toEqual([null, observer]);
      expect(getCancellation(reason)).toEqual({
        signal: caller.signal,
        reason: null,
        primary: { kind: "abort" },
        extra: [observer],
      });
    });
  });

  it("does not inherit an earlier request's cancellation tuple from a borrowed reason", async () => {
    const first = new AbortController();
    const value = new Error("Authored first caller reason");
    const borrowed = await rejectedResponse(sendRequest(async () => ({ input: TEST_URL }), {
      signal: first.signal,
      replayable: false,
      fetch: async () => {
        first.abort(value);
        throw value;
      },
    }));
    expect(getCancellation(borrowed)?.signal).toBe(first.signal);
    const second = new AbortController();
    const observer = new Error("Authored second request observer");
    let requests = 0;
    const reason = await rejectedResponse(sendRequest(async () => {
      throw borrowed;
    }, {
      signal: second.signal,
      fetch: async () => {
        requests++;
        return new Response(null);
      },
      metrics: new FaultMetrics({
        failure() {
          throw observer;
        },
      }),
      policy: { retries: 2, minDelayMs: 0, maxDelayMs: 0, jitter: 0 },
    }));
    if (!(reason instanceof AggregateError)) throw reason;
    expect(reason.errors).toEqual([borrowed, observer]);
    expect(getCancellation(reason)).toBeUndefined();
    expect(getCancellation(borrowed)?.signal).toBe(first.signal);
    expect(second.signal.aborted).toBe(false);
    expect(requests).toBe(0);
  });

  it("a callback-thrown timeout-shaped reason cannot grant preparation replay", async () => {
    const timeout = new DOMException("Authored callback value", "TimeoutError");
    let preparations = 0;
    let requests = 0;
    expect(
      await rejectedResponse(sendRequest(async () => {
        preparations++;
        throw timeout;
      }, {
        fetch: async () => {
          requests++;
          return new Response(null);
        },
        policy: { retries: 2, timeoutMs: 10_000, minDelayMs: 0, maxDelayMs: 0, jitter: 0 },
      })),
    ).toBe(timeout);
    expect(preparations).toBe(1);
    expect(requests).toBe(0);
  });
});
