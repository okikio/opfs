import { describe, it } from "node:test";
import { expect } from "@std/expect";
import {
  createPubsubClient,
  PubsubDeliverySchema,
  PubsubError,
  PubsubMessageSchema,
  PubsubOutcomeError,
} from "../src/pubsub.ts";
import type { FetchType } from "../src/request.ts";
import { encodeBase64 } from "@std/encoding/base64";
const endpoint = "https://pubsub.example/", project = "opfs-pubsub";
const bytes = new Uint8Array([0, 255, 17, 42, 128, 9]);
const delivery = () => ({
  ackId: "delivery-token",
  message: {
    messageId: "90071992547409931234",
    publishTime: "2026-11-05T00:01:02.123456789Z",
    data: encodeBase64(bytes),
    attributes: { kind: "binary" },
  },
  deliveryAttempt: 0,
});
function client(fetch: FetchType, more = {}) {
  return createPubsubClient({ endpoint, project, fetch, ...more });
}
function response(value: unknown): Response {
  return Response.json(value);
}
async function unknown(action: Promise<unknown>, operation: string): Promise<PubsubOutcomeError> {
  try {
    await action;
    throw new Error("Expected uncertain outcome.");
  } catch (reason) {
    expect(reason).toBeInstanceOf(PubsubOutcomeError);
    const result = reason as PubsubOutcomeError;
    expect(result.operation).toBe(operation);
    expect(result.outcome).toBe("unknown");
    return result;
  }
}
describe("native Pub/Sub unary REST", () => {
  it("preserves exact binary data, opaque IDs and UTC nanoseconds without implicit acknowledgement", async () => {
    const requests: string[] = [];
    const api = client(async (input, init) => {
      requests.push(String(input));
      expect(init?.redirect).toBe("manual");
      expect(init?.credentials).toBe("omit");
      expect(JSON.parse(String(init?.body))).toEqual({ maxMessages: 2 });
      return response({ receivedMessages: [delivery()] });
    });
    const batch = await api.pull("events-sub", { maxMessages: 2 });
    expect(batch.length).toBe(1);
    expect(batch[0]!.bytes).toEqual(bytes);
    expect(batch[0]!.messageId).toBe("90071992547409931234");
    expect(batch[0]!.publishTime).toBe("2026-11-05T00:01:02.123456789Z");
    expect(batch[0]!.deliveryAttempt).toBe(0);
    batch[0]!.bytes.fill(7);
    expect((await api.pull("events-sub", { maxMessages: 2 }))[0]!.bytes).toEqual(bytes);
    expect(requests).toEqual([
      `${endpoint}v1/projects/${project}/subscriptions/events-sub:pull`,
      `${endpoint}v1/projects/${project}/subscriptions/events-sub:pull`,
    ]);
  });
  it("accepts omitted, null, empty array and empty-body pull results without backlog claims", async () => {
    for (const raw of ["{}", '{"receivedMessages":[]}', '{"receivedMessages":null}', "", " \n"]) {
      expect(await client(async () => new Response(raw)).pull("events-sub", { maxMessages: 1 })).toEqual([]);
    }
  });
  it("snapshots bytes, one-read getters, attributes, target URL and options before awaited credentials", async () => {
    const source = new Uint8Array(bytes),
      attrs = { kind: "before" },
      options = { signal: new AbortController().signal };
    let getterReads = 0, dispatches = 0;
    const message = {
      get bytes() {
        getterReads++;
        return source;
      },
      attributes: attrs,
    };
    const api = client(async (input, init) => {
      dispatches++;
      expect(String(input)).toBe(`${endpoint}v1/projects/${project}/topics/events%25%2B:publish`);
      expect(JSON.parse(String(init?.body))).toEqual({
        messages: [{ data: encodeBase64(bytes), attributes: { kind: "before" } }],
      });
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer owned");
      return response({ messageIds: ["18446744073709551615"] });
    }, {
      credentials: async (url: URL) => {
        source.fill(9);
        attrs.kind = "after";
        url.hostname = "foreign.invalid";
        const changed = new AbortController();
        changed.abort("changed after admission");
        options.signal = changed.signal;
        await Promise.resolve();
        return { authorization: "Bearer owned" };
      },
    });
    expect(await api.publish("events%+", [message], options)).toEqual(["18446744073709551615"]);
    expect(getterReads).toBe(1);
    expect(dispatches).toBe(1);
  });
  it("publishes attribute-only messages and validates data-or-attributes and encoded batch bounds before credentials", async () => {
    let tokens = 0, sends = 0;
    const api = client(async (_input, init) => {
      sends++;
      expect(JSON.parse(String(init?.body))).toEqual({ messages: [{ attributes: { empty: "" } }] });
      return response({ messageIds: ["one"] });
    }, {
      credentials: () => {
        tokens++;
      },
    });
    expect(await api.publish("events", [{ attributes: { empty: "" } }])).toEqual(["one"]);
    for (
      const message of [{}, { bytes: new Uint8Array(0) }, { attributes: {} }, { bytes: new Uint8Array(1048577) }, {
        attributes: { bad: "\ud800" },
      }, { bytes, messageId: "forged" }]
    ) await expect(api.publish("events", [message])).rejects.toThrow();
    expect(PubsubMessageSchema.safeParse({}).success).toBe(false);
    expect(PubsubMessageSchema.safeParse({ attributes: { empty: "" } }).success).toBe(true);
    const largeAttrs = Object.fromEntries(Array.from({ length: 100 }, (_, n) => [`key${n}`, "\0".repeat(1024)]));
    await expect(api.publish("events", Array.from({ length: 20 }, () => ({ attributes: largeAttrs })))).rejects.toThrow(
      "encoded",
    );
    expect(tokens).toBe(1);
    expect(sends).toBe(1);
  });
  it("rejects unrelated/partial/duplicate publish receipts as unknown without retry", async () => {
    for (const receipt of [{}, { messageIds: [] }, { messageIds: ["a", "b"] }, { messageIds: ["bad id"] }]) {
      let attempts = 0;
      const api = client(async () => {
        attempts++;
        return response(receipt);
      });
      await unknown(api.publish("events", [{ bytes }]), "publish");
      expect(attempts).toBe(1);
    }
    await unknown(
      client(async () => response({ messageIds: ["same", "same"] })).publish("events", [{ bytes }, { bytes }]),
      "publish",
    );
  });
  it("treats pull, ack and deadline changes as mutating and captures ack arrays before token awaits", async () => {
    const ids = ["one"], bodies: unknown[] = [];
    const api = client(async (_input, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      return response({});
    }, {
      credentials: () => {
        ids[0] = "changed";
      },
    });
    await api.acknowledge("events-sub", ids);
    ids[0] = "two";
    await api.modifyAckDeadline("events-sub", ids, 0);
    expect(bodies).toEqual([{ ackIds: ["one"] }, { ackIds: ["two"], ackDeadlineSeconds: 0 }]);
    for (const op of ["pull", "acknowledge", "modifyAckDeadline"] as const) {
      const api = client(async () => {
        throw new Error("lost transport receipt");
      });
      await unknown(
        op === "pull"
          ? api.pull("events-sub", { maxMessages: 1 })
          : op === "acknowledge"
          ? api.acknowledge("events-sub", ["token"])
          : api.modifyAckDeadline("events-sub", ["token"], 600),
        op,
      );
    }
    await expect(api.modifyAckDeadline("events-sub", ["token"], 601)).rejects.toThrow();
    await expect(api.acknowledge("events-sub", ["token", "token"])).rejects.toThrow();
  });
  it("refuses malformed/lossy/duplicate JSON and unrelated message grammar before returning delivery state", async () => {
    for (
      const raw of [
        '{"receivedMessages":[],"receivedMessages":[]}',
        '{"receivedMessages":[],"other":1e-324}',
        '{"receivedMessages":[],"other":9007199254740991.1}',
        '{"receivedMessages":[],"__proto__":{}}',
        JSON.stringify({ receivedMessages: [{ ...delivery(), deliveryAttempt: 0.5 }] }),
        JSON.stringify({
          receivedMessages: [{
            ...delivery(),
            message: { ...delivery().message, publishTime: "2026-02-30T00:00:00Z" },
          }],
        }),
        JSON.stringify({ receivedMessages: [{ ...delivery(), message: { ...delivery().message, data: "AB==" } }] }),
        JSON.stringify({ receivedMessages: [delivery(), delivery()] }),
        JSON.stringify({ receivedMessages: [{ ...delivery(), ackId: "" }] }),
      ]
    ) await unknown(client(async () => new Response(raw)).pull("events-sub", { maxMessages: 2 }), "pull");
  });
  it("preserves known native refusal plus independent unused-body cleanup failure", async () => {
    const cleanup = new Error("owned cleanup failed");
    const body = new ReadableStream<Uint8Array>({
      cancel() {
        throw cleanup;
      },
    });
    try {
      await client(async () => new Response(body, { status: 404 })).acknowledge("missing-sub", ["token"]);
      throw new Error("Expected native refusal.");
    } catch (reason) {
      expect(reason).toBeInstanceOf(AggregateError);
      const errors = (reason as AggregateError).errors;
      expect(errors[0]).toBeInstanceOf(PubsubError);
      expect(errors[0].status).toBe(404);
      expect(errors[1]).toBe(cleanup);
    }
  });
  it("owns control bodies: validates actual lengths/fatal UTF8, cancels local failures and preserves native read rejection", async () => {
    let cancels = 0;
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode("{}"));
      },
      cancel() {
        cancels++;
      },
    });
    await unknown(
      client(async () => new Response(body, { headers: { "content-length": "999999999" } })).pull("events-sub", {
        maxMessages: 1,
      }),
      "pull",
    );
    expect(cancels).toBe(1);
    for (
      const reply of [
        new Response(new Uint8Array([255])),
        new Response("{}", { headers: { "content-length": "3" } }),
        new Response("{}", { headers: { "content-encoding": "gzip" } }),
      ]
    ) await unknown(client(async () => reply).pull("events-sub", { maxMessages: 1 }), "pull");
    const readFailure = new Error("native read failed");
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.error(readFailure);
      },
    });
    const error = await unknown(
      client(async () => new Response(stream)).pull("events-sub", { maxMessages: 1 }),
      "pull",
    );
    expect(error.cause).toBe(readFailure);
  });
  it("retains transport EOF cleanup failure as unknown before a complete body boundary is delivered", async () => {
    const cleanup = new Error("success reader release failed");
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode('{"messageIds":["one"]}'));
        c.close();
      },
    });
    const acquire = body.getReader.bind(body);
    Object.defineProperty(body, "getReader", {
      value: () => {
        const reader = acquire(), release = reader.releaseLock.bind(reader);
        Object.defineProperty(reader, "releaseLock", {
          value: () => {
            release();
            throw cleanup;
          },
        });
        return reader;
      },
    });
    const error = await unknown(client(async () => new Response(body)).publish("events", [{ bytes }]), "publish");
    expect(error.cause).toBe(cleanup);
  });
  it("does not forward OAuth across redirects or acquire credentials for preaborted/invalid work", async () => {
    let tokens = 0, calls = 0;
    const controller = new AbortController();
    controller.abort("before");
    const api = client(async () => {
      calls++;
      return new Response("", { status: 307, headers: { location: "https://foreign.invalid/?secret" } });
    }, {
      credentials: () => {
        tokens++;
        return { authorization: "Bearer owned" };
      },
    });
    await expect(api.pull("events-sub", { maxMessages: 1, signal: controller.signal })).rejects.toBe("before");
    await expect(api.publish("../foreign", [{ bytes }])).rejects.toThrow();
    expect(tokens).toBe(0);
    const error = await unknown(api.publish("events", [{ bytes }]), "publish");
    expect(String(error)).not.toContain("foreign");
    expect(calls).toBe(1);
    expect(tokens).toBe(1);
    expect(() =>
      createPubsubClient({ endpoint: "https://api.invalid/path/", project, fetch: async () => response({}) })
    ).toThrow();
  });
  it("aborts a stalled owned response body at the operation deadline and releases its reader", async () => {
    let cancelled = 0;
    const body = new ReadableStream<Uint8Array>({
      cancel() {
        cancelled++;
      },
    });
    const keeper = setTimeout(() => {}, 500);
    try {
      await unknown(
        client(async () => new Response(body), { timeoutMs: 10 }).pull("events-sub", { maxMessages: 1 }),
        "pull",
      );
    } finally {
      clearTimeout(keeper);
    }
    expect(cancelled).toBe(1);
    expect(body.locked).toBe(false);
  });
  it("validates normalized delivery field grammar without claiming server-issued provenance", () => {
    const value = {
      ackId: "token",
      messageId: "9007199254740993",
      bytes,
      publishTime: "2026-11-05T00:00:00.123456789Z",
      attributes: {},
    };
    expect(PubsubDeliverySchema.safeParse(value).success).toBe(true);
    for (
      const change of [
        { ackId: "" },
        { publishTime: "2026-02-30T00:00:00Z" },
        { bytes: new Uint8Array(1048577) },
        { bytes: new Uint8Array(0) },
        { deliveryAttempt: 2147483648 },
        { orderingKey: "x".repeat(1025) },
      ]
    ) expect(PubsubDeliverySchema.safeParse({ ...value, ...change }).success).toBe(false);
  });
  it("admits the full local message boundary and snapshots bytes before another caller getter runs", async () => {
    const original = Uint8Array.from({ length: 1048576 }, (_, index) => index % 251);
    const large = delivery();
    large.message.data = encodeBase64(original);
    const received = await client(async () => response({ receivedMessages: [large] })).pull("events-sub", {
      maxMessages: 1,
    });
    const actual = received[0]!.bytes;
    expect(actual.length).toBe(original.length);
    for (let at = 0; at < original.length; at++) {
      if (actual[at] !== original[at]) throw new Error(`Pub/Sub complete byte mismatch at ${at}.`);
    }
    const source = new Uint8Array(bytes);
    const message = {
      bytes: source,
      get attributes() {
        source.fill(77);
        return { kind: "after byte capture" };
      },
    };
    const api = client(async (_input, init) => {
      expect(JSON.parse(String(init?.body)).messages[0].data).toBe(encodeBase64(bytes));
      return response({ messageIds: ["one"] });
    });
    await api.publish("events", [message]);
  });
  it("does not dispatch if credential callback fails or supplies a noncredential header", async () => {
    const failure = new Error("caller token failed");
    let calls = 0;
    const fetch: FetchType = async () => {
      calls++;
      return response({});
    };
    await expect(
      client(fetch, {
        credentials: () => {
          throw failure;
        },
      }).publish("events", [{ bytes }]),
    ).rejects.toBe(failure);
    await expect(
      client(fetch, { credentials: () => ({ host: "foreign.invalid" }) }).pull("events-sub", { maxMessages: 1 }),
    ).rejects.toThrow("Authorization");
    expect(calls).toBe(0);
  });
});
