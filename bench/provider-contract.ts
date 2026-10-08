import { deepStrictEqual, equal, ok } from "node:assert/strict";
import { createServer, request } from "node:http";
import type { IncomingMessage } from "node:http";
import type { Socket } from "node:net";
import type { Readable, Writable } from "node:stream";

/** Writes one chunk or EOF while retaining drain, failure and cancellation authority. */
function write(
  destination: Writable,
  chunk: Uint8Array | undefined,
  signal: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const event = chunk === undefined ? "finish" : "drain";
    const settle = (failed: boolean, reason?: unknown) => {
      destination.removeListener(event, complete);
      destination.removeListener("error", failure);
      destination.removeListener("close", closed);
      signal.removeEventListener("abort", aborted);
      if (failed) reject(reason);
      else resolve();
    };
    const complete = () => settle(false);
    const failure = (reason: unknown) => settle(true, reason);
    const closed = () => failure(new Error("Provider forwarding destination closed before completion."));
    const aborted = () => failure(signal.reason);
    destination.once(event, complete);
    destination.once("error", failure);
    destination.once("close", closed);
    signal.addEventListener("abort", aborted, { once: true });
    if (signal.aborted) return aborted();
    if (destination.destroyed) return closed();
    try {
      if (chunk === undefined) destination.end();
      else if (destination.write(chunk)) complete();
    } catch (reason) {
      failure(reason);
    }
  });
}

/**
 * Explicit stream backpressure works in Node and Bun without buffering a document.
 * Bun's node:http pipe forwarding stalled a five-MiB request although its native
 * direct upload completed. Cancellation destroys the source to release iteration.
 */
async function forward(source: Readable, destination: Writable, signal: AbortSignal): Promise<void> {
  const abort = () => source.destroy();
  signal.addEventListener("abort", abort, { once: true });
  try {
    if (signal.aborted) {
      source.destroy();
      throw signal.reason;
    }
    for await (const value of source) {
      const chunk: unknown = value;
      if (!(chunk instanceof Uint8Array)) throw new TypeError("Provider forwarding requires byte chunks.");
      await write(destination, chunk, signal);
    }
    await write(destination, undefined, signal);
  } finally {
    signal.removeEventListener("abort", abort);
  }
}

/** Retains protocol roles only, including partial observations when an operation fails. */
function histogram(calls: readonly string[]): Record<string, number> {
  const value: Record<string, number> = {};
  for (const call of calls) value[call] = (value[call] ?? 0) + 1;
  return value;
}

/** Fixed protocol roles keep diagnostics bounded and omit credentials and signed URLs. */
function role(method: string, path: string): string {
  const query = new URL(path, "http://fixture.invalid").searchParams;
  if (method === "HEAD") return "HEAD stat";
  if (query.has("list-type") || query.get("comp") === "list") return `${method} list`;
  if (query.has("uploads")) return `${method} initiate`;
  if (query.has("partNumber")) return `${method} part`;
  if (query.has("uploadId")) return `${method} commit`;
  if (query.get("comp") === "block") return `${method} block`;
  if (query.get("comp") === "blocklist") return `${method} commit`;
  return `${method} object`;
}

/** One loopback untimed HTTP listener for a fixed caller-owned upstream; timing uses the original endpoint. */
export interface ProviderObserverType {
  readonly endpoint: string;
  /** Checks exact physical calls and acknowledgement ordering before independent body verification. */
  check<Type>(lane: string, operation: () => Promise<Type>, expected: Readonly<Record<string, number>>): Promise<Type>;
  close(): Promise<void>;
}

/**
 * Streams requests to one caller-owned HTTP fixture without changing signed Host headers.
 *
 * The listener is loopback-only; the upstream can be a Testcontainers gateway or
 * network name. The caller owns that fixture through observation and cleanup.
 * URL credentials, query and fragment are unsupported rather than silently ignored.
 * Incoming Host/path data never changes the acquired hostname/port. This private
 * benchmark transport is not a production proxy or a network security sandbox.
 * Bodies retain explicit backpressure; only 64 method/role records are retained
 * per observation, with a 30-second request deadline. Timings bypass this listener.
 */
export async function observeProvider(
  endpoint: string,
  options: {
    readonly timeoutMs?: number;
    /** Benchmark-fixture seam for deterministic deadline controls; real runs use native timers. */
    readonly watchdog?: (expire: () => void, timeoutMs: number) => () => void;
  } = {},
): Promise<ProviderObserverType> {
  const timeoutMs = options.timeoutMs ?? 30_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new RangeError("Invalid observation watchdog.");
  const watchdog = options.watchdog ?? ((expire: () => void, delay: number) => {
    const timer = setTimeout(expire, delay);
    return () => clearTimeout(timer);
  });
  const target = new URL(endpoint);
  if (
    target.protocol !== "http:" || target.username !== "" || target.password !== "" ||
    /^http:\/\/[^/?#]*@/iu.test(endpoint.trim()) ||
    target.href.includes("?") || target.href.includes("#")
  ) {
    throw new TypeError("Provider observations require an owned HTTP fixture without URL userinfo, query or fragment.");
  }
  // URL brackets identify IPv6 syntax; native request hostname takes the address itself.
  const hostname = target.hostname.startsWith("[") ? target.hostname.slice(1, -1) : target.hostname;
  const port = target.port || "80";
  const sockets = new Set<Socket>();
  const exchanges = new Map<Promise<void>, (reason: Error) => void>();
  let poisoned = false;
  let closed = false;
  let closure: Promise<void> | undefined;
  let rejectActive: ((reason: Error) => void) | undefined;
  let exchangeFailures: unknown[] = [];
  const own = (socket: Socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  };
  let calls: string[] | undefined;
  const server = createServer((incoming, response) => {
    const path = incoming.url ?? "/";
    if (!path.startsWith("/") || closed || poisoned || exchanges.size === 64 || calls?.length === 64) {
      if (!closed && !poisoned && calls !== undefined && exchangeFailures.length < 64) {
        exchangeFailures.push(new Error("Provider observation route or exchange admission limit exceeded."));
      }
      response.writeHead(503).end(() => incoming.destroy());
      return;
    }
    if (calls !== undefined) {
      calls.push(role(incoming.method ?? "GET", path));
    }
    const controller = new AbortController();
    let received: IncomingMessage | undefined;
    const outgoing = request({
      hostname,
      port,
      path,
      method: incoming.method,
      headers: incoming.headers,
      agent: false,
    });
    outgoing.once("socket", own);
    const cancel = (reason: Error) => {
      if (controller.signal.aborted) return;
      if (calls !== undefined && exchangeFailures.length < 64) exchangeFailures.push(reason);
      controller.abort(reason);
      outgoing.destroy(reason);
      incoming.destroy(reason);
      received?.destroy(reason);
      response.destroy(reason);
    };
    const stopDeadline = watchdog(() => cancel(new Error("Provider observation request watchdog expired.")), timeoutMs);
    outgoing.on("error", cancel);
    incoming.on("aborted", () => cancel(new Error("Provider observation consumer aborted.")));
    incoming.on("error", cancel);
    response.on("error", cancel);
    response.on("close", () => {
      if (!response.writableFinished) cancel(new Error("Provider observation consumer closed."));
    });
    outgoing.on("response", (value) => {
      if (controller.signal.aborted) value.destroy();
    });
    const reply = new Promise<IncomingMessage>((resolve, reject) => {
      const clear = () => {
        outgoing.removeListener("response", arrived);
        outgoing.removeListener("error", failed);
        outgoing.removeListener("close", closed);
        controller.signal.removeEventListener("abort", aborted);
      };
      const arrived = (value: IncomingMessage) => {
        clear();
        resolve(value);
      };
      const failed = (reason: unknown) => {
        clear();
        reject(reason);
      };
      const closed = () => failed(new Error("Provider request closed before its response."));
      const aborted = () => failed(controller.signal.reason);
      outgoing.once("response", arrived);
      outgoing.once("error", failed);
      outgoing.once("close", closed);
      controller.signal.addEventListener("abort", aborted, { once: true });
      if (controller.signal.aborted) aborted();
    });
    const forwarding = [
      forward(incoming, outgoing, controller.signal),
      reply.then(async (value) => {
        received = value;
        received.on("error", cancel);
        if (controller.signal.aborted) {
          received.destroy();
          throw controller.signal.reason;
        }
        response.writeHead(received.statusCode ?? 502, received.headers);
        await forward(received, response, controller.signal);
      }),
    ].map((task) =>
      task.catch((reason: unknown) => {
        cancel(reason instanceof Error ? reason : new Error("Provider forwarding failed.", { cause: reason }));
        throw reason;
      })
    );
    // A first rejection cancels its sibling; both forwarding tasks settle before release.
    const exchange = Promise.allSettled(forwarding).then(() => {}).finally(() => {
      stopDeadline();
      exchanges.delete(exchange);
    });
    exchanges.set(exchange, cancel);
  });
  server.on("connection", own);
  let address: ReturnType<typeof server.address>;
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.removeListener("error", reject);
        resolve();
      });
    });
    address = server.address();
    if (address === null || typeof address === "string") throw new Error("Provider observer has no loopback address.");
  } catch (primary) {
    for (const socket of sockets) socket.destroy();
    if (server.listening) {
      try {
        await new Promise<void>((resolve, reject) => server.close((reason) => reason ? reject(reason) : resolve()));
      } catch (cleanup) {
        throw new AggregateError([primary, cleanup], "Provider observer acquisition failed.", { cause: primary });
      }
    }
    throw primary;
  }
  return {
    endpoint: `http://127.0.0.1:${address.port}${target.pathname}`,
    async check<Type>(
      lane: string,
      operation: () => Promise<Type>,
      expected: Readonly<Record<string, number>>,
    ): Promise<Type> {
      equal(calls, undefined, "Provider preflights must run serially.");
      if (closed) throw new Error("The provider observer is closed.");
      if (poisoned) {
        throw new Error("A failed provider observer must be closed; late native requests cannot be reused.");
      }
      const observed: string[] = [];
      calls = observed;
      exchangeFailures = [];
      let stopDeadline: (() => void) | undefined;
      try {
        const expired = new Promise<never>((_resolve, reject) => {
          stopDeadline = watchdog(() => {
            const reason = new Error(`${lane}: provider observation watchdog expired.`, {
              cause: { code: "OPFS_PROVIDER_OBSERVATION_TIMEOUT", calls: histogram(observed) },
            });
            for (const cancel of exchanges.values()) cancel(reason);
            for (const socket of sockets) socket.destroy();
            reject(reason);
          }, timeoutMs);
        });
        const terminal = new Promise<never>((_resolve, reject) => rejectActive = reject);
        const completion = (async () => {
          const result = await operation();
          await Promise.all(exchanges.keys());
          if (closed || poisoned) throw new Error("Provider observation ended before completion.");
          if (exchangeFailures.length) throw new AggregateError(exchangeFailures, `${lane}: forwarding failed.`);
          deepStrictEqual(histogram(observed), expected, `${lane}: physical protocol work`);
          const publication = observed.findLastIndex((call) => call === "PUT object" || call.endsWith(" commit"));
          ok(publication >= 0, `${lane}: publication request missing`);
          ok(
            !observed.slice(publication + 1).some((call) => call.startsWith("HEAD ") || call.endsWith(" list")),
            `${lane}: a post-publication read is not an own-operation acknowledgement`,
          );
          return result;
        })();
        const result = await Promise.race([completion, expired, terminal]);
        console.error(
          JSON.stringify({ providerPreflight: lane, calls: histogram(observed), publicationAcknowledged: true }),
        );
        return result;
      } catch (reason) {
        // Native operations can lack cancellation. Refuse late requests and reuse after failure.
        poisoned = true;
        const failure = reason instanceof Error ? reason : new Error("Provider observation failed.", { cause: reason });
        for (const cancel of exchanges.values()) cancel(failure);
        for (const socket of sockets) socket.destroy();
        await Promise.all(exchanges.keys());
        console.error(
          JSON.stringify({ providerPreflight: lane, calls: histogram(observed), publicationAcknowledged: false }),
        );
        throw reason;
      } finally {
        stopDeadline?.();
        rejectActive = undefined;
        calls = undefined;
      }
    },
    close(): Promise<void> {
      if (closure !== undefined) return closure;
      closed = true;
      const reason = new Error("Provider observer closed.");
      rejectActive?.(reason);
      for (const cancel of exchanges.values()) cancel(reason);
      for (const socket of sockets) socket.destroy();
      closure = (async () => {
        await Promise.all(exchanges.keys());
        await new Promise<void>((resolve, reject) => server.close((reason) => reason ? reject(reason) : resolve()));
      })();
      return closure;
    },
  };
}

/** Project write receipts retain observed input size and their own provider acknowledgement identity. */
export function expectReceipt(
  receipt: { readonly size: number; readonly etag?: string },
  bytes: Uint8Array,
  lane: string,
): void {
  equal(receipt.size, bytes.byteLength, `${lane}: acknowledged input size`);
  ok(typeof receipt.etag === "string" && receipt.etag.length > 0, `${lane}: publication ETag`);
}

/** SDK response ETags are checked directly; a later stat is only current-state validation. */
export function expectEtag(etag: string | undefined, lane: string): void {
  ok(typeof etag === "string" && etag.length > 0, `${lane}: publication ETag`);
}
