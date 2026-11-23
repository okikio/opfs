/** Authored wire and lifecycle controls; these are not a native provider oracle. */
import { describe, it } from "node:test";
import { expect } from "@std/expect";
import { encodeBase64 } from "@std/encoding/base64";
import {
  createNetlifyClient,
  NETLIFY_PROFILE,
  NetlifyCompletionError,
  NetlifyError,
  NetlifyPublicationError,
} from "../src/netlify.ts";
import type { NetlifyOptionsType } from "../src/netlify.ts";
import type { FetchType } from "../src/request.ts";

interface CallType {
  readonly url: string;
  readonly init: RequestInit;
  readonly headers: Headers;
}
function client(fetch: FetchType, options: Partial<NetlifyOptionsType> = {}) {
  return createNetlifyClient({
    profile: NETLIFY_PROFILE,
    api: "https://api.example",
    site: "owned-site",
    store: "owned-store",
    token: "account-secret",
    fetch,
    authorizeDataURL: (url) => new URL(url).origin === "https://data.example",
    ...options,
  });
}
function signed(url = "https://data.example/object?signature=A%2Fb+Z&x=1"): Response {
  return Response.json({ url });
}
function sequence(responses: readonly (Response | ((call: CallType) => Response | Promise<Response>))[]) {
  const calls: CallType[] = [];
  const fetch: FetchType = async (input, init = {}) => {
    const call = { url: String(input), init, headers: new Headers(init.headers) };
    const response = responses[calls.length];
    calls.push(call);
    if (response === undefined) throw new Error("Unexpected additional Fetch attempt.");
    return typeof response === "function" ? await response(call) : response;
  };
  return { calls, fetch };
}
async function rejection(action: () => Promise<unknown>): Promise<unknown> {
  try {
    await action();
  } catch (error) {
    return error;
  }
  throw new Error("Expected operation refusal.");
}

describe("Netlify SDK-wire compatibility client", () => {
  it("constructs without fetching or authorizing capabilities and rejects ambiguous raw identities", () => {
    let calls = 0;
    const owner = client(async () => {
      calls++;
      throw new Error("Not reached.");
    }, {
      authorizeDataURL: () => {
        calls++;
        return true;
      },
    });
    expect(calls).toBe(0);
    for (const key of ["", "/a", "a//b", ".", "a/..", "a/%2F", "a?x", "a#x", "a\\b", "猫", "a/\ud800"]) {
      expect(() => owner.get(key)).toThrow(TypeError);
    }
    for (
      const options of [
        { api: "https://api.example/path" },
        { api: "https://user@api.example" },
        { api: "http://api.example" },
        { api: " https://api.example" },
        { store: "site:store" },
        { maxBytes: Infinity },
        { timeoutMs: 0 },
      ]
    ) expect(() => client(async () => new Response(), options)).toThrow(TypeError);
    expect(calls).toBe(0);
  });

  it("keeps GET negotiation bearer separate from the exact approved signed query and cache condition", async () => {
    const metadata = { title: "café-猫", value: [null, 1, true] };
    const mock = sequence([
      signed(),
      new Response(Uint8Array.of(0, 255, 7), {
        headers: {
          "content-length": "3",
          "x-amz-meta-user": "b64;" + encodeBase64(new TextEncoder().encode(JSON.stringify(metadata))),
        },
      }),
    ]);
    const result = await client(mock.fetch).get("folder/key.bin", { etag: '"cached"' });
    expect(result.state).toBe("present");
    if (result.state !== "present") throw new Error("Expected full snapshot.");
    expect(Array.from(result.bytes)).toEqual([0, 255, 7]);
    expect(result.size).toBe(3);
    expect(result.etag).toBeUndefined();
    expect(result.metadata).toEqual(metadata);
    expect(mock.calls[0]!.url).toBe("https://api.example/api/v1/blobs/owned-site/site:owned-store/folder/key.bin");
    expect(mock.calls[0]!.headers.get("authorization")).toBe("Bearer account-secret");
    expect(mock.calls[0]!.headers.get("accept")).toBe("application/json;type=signed-url");
    expect(mock.calls[0]!.headers.has("if-none-match")).toBe(false);
    expect(mock.calls[0]!.init.body).toBeUndefined();
    expect(mock.calls[1]!.url).toBe("https://data.example/object?signature=A%2Fb+Z&x=1");
    expect(mock.calls[1]!.headers.has("authorization")).toBe(false);
    expect(mock.calls[1]!.headers.get("if-none-match")).toBe('"cached"');
    for (const call of mock.calls) {
      expect(call.init.redirect).toBe("error");
      expect(call.init.credentials).toBe("omit");
    }
    expect(result.work.requests).toBe(2);
  });

  it("never adds the account bearer even when an explicitly approved data URL shares the API origin", async () => {
    const mock = sequence([signed("https://api.example/capability?sig=opaque"), new Response()]);
    const result = await client(mock.fetch, { authorizeDataURL: () => true }).get("key");
    expect(result.state).toBe("present");
    expect(mock.calls[1]!.headers.has("authorization")).toBe(false);
  });

  it("rejects unauthorized, insecure or malformed capabilities before the data request", async () => {
    for (
      const url of [
        "https://other.example/x",
        "http://data.example/x",
        "https://u:p@data.example/x",
        "https://data.example/x#fragment",
        "https://data.example/x?sig=a b",
      ]
    ) {
      const mock = sequence([signed(url)]);
      expect(await rejection(() => client(mock.fetch).get("key"))).toBeInstanceOf(NetlifyError);
      expect(mock.calls.length).toBe(1);
    }
    const denied = sequence([signed()]);
    const error = await rejection(() =>
      client(denied.fetch, { authorizeDataURL: () => false }).put("key", Uint8Array.of(1))
    );
    expect(error).toBeInstanceOf(NetlifyError);
    expect(error).not.toBeInstanceOf(NetlifyPublicationError);
  });

  it("requires a literal true capability grant rather than an accidentally asynchronous or truthy result", async () => {
    for (const decision of [() => Promise.resolve(false), () => "yes", () => 1]) {
      const options: Partial<NetlifyOptionsType> = {};
      Object.defineProperty(options, "authorizeDataURL", { value: decision, enumerable: true });
      const mock = sequence([signed()]);
      const error = await rejection(() => client(mock.fetch, options).get("key"));
      expect(error).toBeInstanceOf(NetlifyError);
      expect(mock.calls.length).toBe(1);
    }
  });

  it("copies PUT input before invoking foreign option getters", async () => {
    const input = Uint8Array.of(1, 2), mock = sequence([signed(), new Response(null)]);
    await client(mock.fetch).put("key", input, {
      get condition() {
        input.fill(255);
        return { kind: "new" as const };
      },
    });
    const copied = mock.calls[1]!.init.body;
    if (!(copied instanceof Uint8Array)) throw new Error("Expected owned input.");
    expect(Array.from(copied)).toEqual([1, 2]);
  });

  it("snapshots PUT bytes and conditions before negotiation and sends conditions only on final PUT", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const mock = sequence([async () => {
      await gate;
      return signed();
    }, new Response(null, { status: 201, headers: { etag: '"new"' } })]);
    const input = Uint8Array.of(0, 255), condition = { kind: "match" as const, etag: '"old"' };
    const promise = client(mock.fetch).put("key", input, { condition });
    input.fill(4);
    condition.etag = '"changed"';
    release!();
    const receipt = await promise;
    expect(receipt.modified).toBe(true);
    expect(receipt.status).toBe(201);
    expect(receipt.etag).toBe('"new"');
    expect(receipt.size).toBe(2);
    expect(mock.calls[0]!.init.method).toBe("PUT");
    expect(mock.calls[0]!.init.body).toBeUndefined();
    expect(mock.calls[0]!.headers.has("if-match")).toBe(false);
    expect(mock.calls[1]!.headers.get("if-match")).toBe('"old"');
    expect(mock.calls[1]!.headers.get("cache-control")).toBe("max-age=0, stale-while-revalidate=60");
    expect(mock.calls[1]!.headers.has("authorization")).toBe(false);
    const body = mock.calls[1]!.init.body;
    if (!(body instanceof Uint8Array)) throw new Error("Expected owned PUT bytes.");
    expect(Array.from(body)).toEqual([0, 255]);
  });

  it("preserves 409/412 as final conditional refusal observations with no retry", async () => {
    for (const status of [409, 412]) {
      const mock = sequence([signed(), new Response(null, { status, headers: { etag: '"not-a-write-receipt"' } })]);
      const receipt = await client(mock.fetch).put("key", new Uint8Array(), { condition: { kind: "new" } });
      expect(receipt.modified).toBe(false);
      expect(receipt.etag).toBeUndefined();
      expect(receipt.status).toBe(status);
      expect(mock.calls[1]!.headers.get("if-none-match")).toBe("*");
      expect(mock.calls.length).toBe(2);
    }
  });

  it("marks lost final PUT replies and unadmitted statuses unknown without replaying", async () => {
    const cause = new Error("Lost data reply.");
    const mock = sequence([signed(), () => {
      throw cause;
    }]);
    const error = await rejection(() => client(mock.fetch).put("key", Uint8Array.of(7)));
    expect(error).toBeInstanceOf(NetlifyPublicationError);
    if (!(error instanceof NetlifyPublicationError)) throw new Error("Expected unknown mutation.");
    expect(error.outcome).toBe("unknown");
    expect(error.operation).toBe("put");
    expect(error.cause).toBe(cause);
    expect(mock.calls.length).toBe(2);
    const refused = sequence([signed(), new Response(null, { status: 500 })]);
    const status = await rejection(() => client(refused.fetch).put("key", new Uint8Array()));
    expect(status).toBeInstanceOf(NetlifyPublicationError);
    if (!(status instanceof NetlifyPublicationError)) throw new Error("Expected unknown mutation.");
    expect(status.cause).toBeInstanceOf(NetlifyError);
  });

  it("does not turn a failed PUT negotiation into an unknown object publication", async () => {
    const mock = sequence([new Response(null, { status: 401 })]);
    const error = await rejection(() => client(mock.fetch).put("key", new Uint8Array()));
    expect(error).toBeInstanceOf(NetlifyError);
    expect(error).not.toBeInstanceOf(NetlifyPublicationError);
    expect(mock.calls.length).toBe(1);
  });

  it("does not admit a known mutation receipt from a transport-followed redirect", async () => {
    for (const operation of ["put", "delete"] as const) {
      const response = new Response(null, { status: 200 });
      Object.defineProperty(response, "redirected", { value: true });
      const mock = sequence(operation === "put" ? [signed(), response] : [response]);
      const owner = client(mock.fetch);
      const error = await rejection(() =>
        operation === "put" ? owner.put("key", Uint8Array.of(1)) : owner.delete("key")
      );
      expect(error).toBeInstanceOf(NetlifyPublicationError);
      expect(error).not.toBeInstanceOf(NetlifyCompletionError);
      if (!(error instanceof NetlifyPublicationError)) throw new Error("Expected unknown original-target mutation.");
      expect(error.operation).toBe(operation);
      expect(error.cause).toBeInstanceOf(NetlifyError);
    }
  });

  it("preserves a known successful PUT receipt when header admission or body cleanup fails", async () => {
    const mock = sequence([signed(), new Response(null, { headers: { oversized: "a".repeat(1024) } })]);
    const error = await rejection(() => client(mock.fetch, { maxHeaderBytes: 512 }).put("key", Uint8Array.of(9)));
    expect(error).toBeInstanceOf(NetlifyCompletionError);
    if (!(error instanceof NetlifyCompletionError)) throw new Error("Expected retained receipt.");
    expect(error.receipt.operation).toBe("put");
    expect(error.receipt.status).toBe(200);
    expect(error.receipt.work.requests).toBe(2);
    if (error.receipt.operation !== "put") throw new Error("Expected PUT receipt.");
    expect(error.receipt.modified).toBe(true);
    expect(error.receipt.size).toBe(1);
    const cleanup = new Error("Cancel failed.");
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(129));
      },
      cancel() {
        throw cleanup;
      },
    });
    const second = sequence([signed(), new Response(body)]);
    const failure = await rejection(() => client(second.fetch, { maxJsonBytes: 128 }).put("key", new Uint8Array()));
    expect(failure).toBeInstanceOf(NetlifyCompletionError);
    if (!(failure instanceof NetlifyCompletionError)) throw new Error("Expected retained receipt.");
    expect(failure.cause).toBeInstanceOf(AggregateError);
    if (!(failure.cause instanceof AggregateError)) {
      throw new Error("Expected independent refusal and cleanup reasons.");
    }
    expect(failure.cause.errors.includes(cleanup)).toBe(true);
    expect(body.locked).toBe(false);
  });

  it("reads HEAD only on API and preserves optional size and ETag without inventing GETs", async () => {
    const mock = sequence([
      new Response(null),
      new Response(null, { status: 404 }),
      new Response(null, { headers: { "content-length": "123", etag: '"observed"' } }),
    ]);
    const owner = client(mock.fetch);
    const first = await owner.head("key");
    expect(first.state).toBe("present");
    if (first.state !== "present") throw new Error("Expected metadata observation.");
    expect(first.size).toBeUndefined();
    expect(first.etag).toBeUndefined();
    expect(first.metadata).toEqual({});
    expect((await owner.head("missing")).state).toBe("absent");
    const known = await owner.head("sized");
    if (known.state !== "present") throw new Error("Expected sized metadata.");
    expect(known.size).toBe(123);
    expect(known.etag).toBe('"observed"');
    for (const call of mock.calls) {
      expect(call.init.method).toBe("HEAD");
      expect(call.headers.get("authorization")).toBe("Bearer account-secret");
      expect(call.headers.has("accept")).toBe(false);
    }
    const unsolicited = sequence([new Response(null, { status: 304 })]);
    expect(await rejection(() => client(unsolicited.fetch).head("key"))).toBeInstanceOf(NetlifyError);
  });

  it("distinguishes absent, conditional not-modified and empty full GETs", async () => {
    const absent = sequence([signed(), new Response(null, { status: 404 })]);
    expect((await client(absent.fetch).get("key")).state).toBe("absent");
    const cached = sequence([signed(), new Response(null, { status: 304, headers: { etag: '"cached"' } })]);
    expect((await client(cached.fetch).get("key", { etag: '"cached"' })).state).toBe("not-modified");
    const unsolicited = sequence([signed(), new Response(null, { status: 304 })]);
    expect(await rejection(() => client(unsolicited.fetch).get("key"))).toBeInstanceOf(NetlifyError);
    const empty = sequence([signed(), new Response(new Uint8Array())]);
    const result = await client(empty.fetch).get("key");
    if (result.state !== "present") throw new Error("Expected empty bytes.");
    expect(result.bytes.length).toBe(0);
    expect(result.size).toBe(0);
  });

  it("preserves one native opaque listing page and query encoding without collecting later pages", async () => {
    const mock = sequence([
      Response.json({
        blobs: [{ key: "a/猫", etag: '"opaque"' }, { key: "unsized" }],
        directories: ["a/"],
        next_cursor: "A+/= opaque?",
      }),
    ]);
    const result = await client(mock.fetch).list({ prefix: "a/猫", directories: true, cursor: "old+/=" });
    expect(result.cursor).toBe("A+/= opaque?");
    expect(result.blobs).toEqual([{ key: "a/猫", etag: '"opaque"' }, { key: "unsized" }]);
    expect(result.directories).toEqual(["a/"]);
    const url = new URL(mock.calls[0]!.url);
    expect(url.pathname).toBe("/api/v1/blobs/owned-site/site:owned-store");
    expect(url.searchParams.get("prefix")).toBe("a/猫");
    expect(url.searchParams.get("cursor")).toBe("old+/=");
    expect(url.searchParams.get("directories")).toBe("true");
    expect(mock.calls[0]!.headers.has("accept")).toBe(false);
    expect(mock.calls.length).toBe(1);
    expect(() => client(mock.fetch).get(result.blobs[0]!.key)).toThrow(TypeError);
  });

  it("refuses malformed listing, unqualified 204 and excessive entries", async () => {
    for (
      const response of [
        Response.json({ blobs: "wrong" }),
        Response.json({ blobs: [{ key: "" }] }),
        Response.json({ directories: [1] }),
        Response.json({ next_cursor: 1 }),
        new Response(null, { status: 204 }),
      ]
    ) {
      const mock = sequence([response]);
      expect(await rejection(() => client(mock.fetch).list())).toBeInstanceOf(NetlifyError);
    }
    const mock = sequence([Response.json({ blobs: [{ key: "one" }], directories: ["two/"] })]);
    const error = await rejection(() => client(mock.fetch, { maxEntries: 1 }).list());
    expect(error).toBeInstanceOf(NetlifyError);
    if (!(error instanceof NetlifyError)) throw new Error("Expected bounded page.");
    expect(error.code).toBe("budget-exceeded");
    const absent = sequence([new Response(null, { status: 404 })]);
    expect((await client(absent.fetch).list()).state).toBe("absent");
  });

  it("keeps unconditional DELETE acknowledgements separate from unknown deletion", async () => {
    for (const status of [200, 204, 404]) {
      const mock = sequence([new Response(null, { status })]);
      const receipt = await client(mock.fetch).delete("key");
      expect(receipt.status).toBe(status);
      expect(receipt.operation).toBe("delete");
      expect(mock.calls[0]!.headers.get("authorization")).toBe("Bearer account-secret");
    }
    const mock = sequence([() => {
      throw undefined;
    }]);
    const error = await rejection(() => client(mock.fetch).delete("key"));
    expect(error).toBeInstanceOf(NetlifyPublicationError);
    if (!(error instanceof NetlifyPublicationError)) throw new Error("Expected unknown deletion.");
    expect(error.cause).toBeUndefined();
  });

  it("admits request, JSON, header, payload and total response limits without silent truncation", async () => {
    const request = sequence([signed()]);
    const error = await rejection(() => client(request.fetch, { maxRequests: 1 }).get("key"));
    expect(error).toBeInstanceOf(NetlifyError);
    expect(request.calls.length).toBe(1);
    const large = sequence([signed(), new Response(Uint8Array.of(1, 2, 3))]);
    expect(await rejection(() => client(large.fetch, { maxBytes: 2 }).get("key"))).toBeInstanceOf(NetlifyError);
    const json = sequence([signed()]);
    expect(await rejection(() => client(json.fetch, { maxJsonBytes: 2 }).get("key"))).toBeInstanceOf(NetlifyError);
    const total = sequence([signed(), new Response(Uint8Array.of(1))]);
    expect(await rejection(() => client(total.fetch, { maxResponseBytes: 1 }).get("key"))).toBeInstanceOf(NetlifyError);
    const mismatch = sequence([signed(), new Response(Uint8Array.of(1), { headers: { "content-length": "2" } })]);
    expect(await rejection(() => client(mismatch.fetch).get("key"))).toBeInstanceOf(NetlifyError);
    const oversize = client(async () => {
      throw new Error("No dispatch.");
    }, { maxBytes: 0 });
    expect(() => oversize.put("key", Uint8Array.of(1))).toThrow(NetlifyError);
  });

  it("bounds alternating empty/tiny response work and cancels without retaining per-chunk arrays", async () => {
    let pulls = 0, canceled = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls++;
        controller.enqueue(pulls % 2 ? new Uint8Array() : Uint8Array.of(1));
      },
      cancel() {
        canceled++;
      },
    }, { highWaterMark: 0 });
    const mock = sequence([signed(), new Response(body)]);
    const error = await rejection(() => client(mock.fetch, { maxReadSteps: 10 }).get("key"));
    expect(error).toBeInstanceOf(NetlifyError);
    expect(pulls).toBeLessThanOrEqual(10);
    expect(canceled).toBe(1);
    expect(body.locked).toBe(false);
  });

  it("returns owned contiguous bytes without retaining a tiny view's oversized backing allocation", async () => {
    const backing = new Uint8Array(1024 * 1024);
    backing.set([7, 8, 9], 100);
    const mock = sequence([
      signed(),
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(backing.subarray(100, 103));
            controller.close();
          },
        }),
      ),
    ]);
    const result = await client(mock.fetch).get("key");
    if (result.state !== "present") throw new Error("Expected owned bytes.");
    backing.fill(255);
    expect(Array.from(result.bytes)).toEqual([7, 8, 9]);
    expect(result.bytes.buffer.byteLength).toBe(3);
  });

  it("refuses malformed negotiation JSON and metadata UTF8/base64 without response-text leakage", async () => {
    for (
      const response of [
        new Response(Uint8Array.of(255)),
        Response.json({ url: 1 }),
        new Response('{"url":1e999}'),
        new Response("[".repeat(18) + "0" + "]".repeat(18)),
      ]
    ) {
      const mock = sequence([response]);
      expect(await rejection(() => client(mock.fetch).get("key"))).toBeInstanceOf(NetlifyError);
    }
    for (const value of ["b64;!", "b64;/w==", "b64;" + encodeBase64(new TextEncoder().encode("{bad}"))]) {
      const mock = sequence([new Response(null, { headers: { "netlify-blobs-metadata": value } })]);
      expect(await rejection(() => client(mock.fetch).head("key"))).toBeInstanceOf(NetlifyError);
    }
  });

  it("rejects a pre-aborted operation before any request", async () => {
    const controller = new AbortController(), reason = new Error("Caller stopped.");
    controller.abort(reason);
    const mock = sequence([]);
    expect(await rejection(() => client(mock.fetch).get("key", { signal: controller.signal }))).toBe(reason);
    expect(mock.calls.length).toBe(0);
  });

  it("aborts and joins an owned pending body read before releasing its lock", async () => {
    const controller = new AbortController();
    let canceled = 0, ready: (() => void) | undefined;
    const pulled = new Promise<void>((resolve) => {
      ready = resolve;
    });
    const body = new ReadableStream<Uint8Array>({
      pull() {
        ready!();
      },
      cancel() {
        canceled++;
      },
    }, { highWaterMark: 0 });
    const mock = sequence([signed(), new Response(body)]), reason = new Error("Stop read.");
    const pending = client(mock.fetch).get("key", { signal: controller.signal });
    await pulled;
    controller.abort(reason);
    expect(await rejection(() => pending)).toBe(reason);
    expect(canceled).toBe(1);
    expect(body.locked).toBe(false);
  });

  it("retains raw terminal body-read errors without inventing a second cancellation failure", async () => {
    for (const cause of [undefined, null, new Error("Native body read failed.")]) {
      for (const operation of ["get", "put"] as const) {
        let cancellations = 0;
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.error(cause);
          },
          cancel() {
            cancellations++;
            throw new Error("Terminal native errors must not be canceled again.");
          },
        });
        const mock = sequence([signed(), new Response(body)]), owner = client(mock.fetch);
        const error = await rejection(() =>
          operation === "get" ? owner.get("key") : owner.put("key", Uint8Array.of(1))
        );
        if (operation === "get") expect(error).toBe(cause);
        else {
          expect(error).toBeInstanceOf(NetlifyCompletionError);
          if (!(error instanceof NetlifyCompletionError)) {
            throw new Error("Expected acknowledged PUT with raw read failure.");
          }
          expect(error.cause).toBe(cause);
          expect(error.receipt.operation).toBe("put");
          expect(error.receipt.status).toBe(200);
          expect(error.receipt.work.requests).toBe(2);
        }
        expect(cancellations).toBe(0);
        expect(body.locked).toBe(false);
        expect(mock.calls.length).toBe(2);
      }
    }
  });

  it("joins abort after final PUT or DELETE dispatch and preserves the unknown outcome without replay", async () => {
    for (const operation of ["put", "delete"] as const) {
      const controller = new AbortController(), cause = new Error(`Stop dispatched ${operation}.`);
      let ready: (() => void) | undefined, mutations = 0, requests = 0, settled = false;
      const dispatched = new Promise<void>((resolve) => {
        ready = resolve;
      });
      const fetch: FetchType = (_input, init = {}) => {
        requests++;
        if (new Headers(init.headers).has("accept")) return Promise.resolve(signed());
        mutations++;
        return new Promise<Response>((_resolve, reject) => {
          const signal = init.signal;
          if (!signal) throw new Error("Dispatched mutation lacks its operation signal.");
          signal.addEventListener("abort", () => {
            settled = true;
            reject(signal.reason);
          }, { once: true });
          ready!();
        });
      };
      const owner = client(fetch);
      const pending = operation === "put"
        ? owner.put("key", Uint8Array.of(1), { signal: controller.signal })
        : owner.delete("key", { signal: controller.signal });
      await dispatched;
      controller.abort(cause);
      const error = await rejection(() => pending);
      expect(error).toBeInstanceOf(NetlifyPublicationError);
      expect(error).not.toBeInstanceOf(NetlifyCompletionError);
      if (!(error instanceof NetlifyPublicationError)) throw new Error("Expected unknown dispatched mutation.");
      expect(error.operation).toBe(operation);
      expect(error.outcome).toBe("unknown");
      expect(error.cause).toBe(cause);
      expect("receipt" in error).toBe(false);
      expect(settled).toBe(true);
      expect(mutations).toBe(1);
      expect(requests).toBe(operation === "put" ? 2 : 1);
    }
  });

  it("uses the operation deadline to abort and join a cooperative transport", async () => {
    let observed = false;
    const owner = client((_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (!signal) throw new Error("Missing operation signal.");
        signal.addEventListener("abort", () => {
          observed = true;
          reject(signal.reason);
        }, { once: true });
      }), { timeoutMs: 5 });
    const error = await rejection(() => owner.head("key"));
    expect(error).toBeInstanceOf(DOMException);
    expect(observed).toBe(true);
  });
});
