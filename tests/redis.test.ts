import { describe, it } from "node:test";
import { expect } from "@std/expect";
import {
  openRedisClient,
  RedisClient,
  RedisError,
  RedisExpirySchema,
  RedisProtocolError,
  RedisPublicationError,
} from "../src/redis.ts";
import type { RedisChannelType, RedisOptionsType, RedisPutType } from "../src/redis.ts";
import { decodeBase64 } from "@std/encoding/base64";
import native from "./fixtures/redis/independent.json" with { type: "json" };

const encode = (value: string): Uint8Array<ArrayBuffer> => new TextEncoder().encode(value);
it("replays unchanged Redis and Valkey GET captures against all independent SDK-original bytes", async () => {
  const original = new Uint8Array(decodeBase64(native.oracle.base64));
  for (const fixture of native.providers) {
    const envelope = new Uint8Array(decodeBase64(fixture.get.base64));
    for (const [record, bytes] of [[fixture.get, envelope], [native.oracle, original]] as const) {
      const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
      expect(Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("")).toBe(record.sha256);
      expect(bytes.length).toBe(record.bytes);
    }
    const wire = peer((request) => {
      expect(request).toEqual(new Uint8Array(decodeBase64(fixture.getRequest.base64)));
      return envelope;
    }, { fragment: true });
    const client = await openRedisClient(wire.config);
    try {
      expect(await client.get(new Uint8Array(decodeBase64(fixture.key.base64)))).toEqual(original);
    } finally {
      if (!client.closed) await client.close();
    }
    expect(wire.closes()).toBe(1);
  }
});
function join(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const result = new Uint8Array(parts.reduce((size, part) => size + part.length, 0));
  let at = 0;
  for (const part of parts) {
    result.set(part, at);
    at += part.length;
  }
  return result;
}
/** Authored independent wire producer: scalar literals plus arbitrary binary payloads, not candidate serialization. */
function bulk(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  return join(encode(`$${bytes.length}\r\n`), bytes, encode("\r\n"));
}
function command(...parts: (string | Uint8Array)[]): Uint8Array<ArrayBuffer> {
  return join(
    encode(`*${parts.length}\r\n`),
    ...parts.map((part) => bulk(typeof part === "string" ? encode(part) : part)),
  );
}
function peer(
  response: (request: Uint8Array, index: number) => Uint8Array | undefined,
  options: { fragment?: boolean; closeError?: unknown; writeError?: unknown } = {},
) {
  let controller!: ReadableStreamDefaultController<Uint8Array>, closes = 0, ended = false;
  const requests: Uint8Array[] = [];
  const send = (bytes: Uint8Array) => {
    if (options.fragment) {
      for (const byte of bytes) controller.enqueue(new Uint8Array([byte]));
    } else controller.enqueue(bytes);
  };
  const channel: RedisChannelType = {
    readable: new ReadableStream({
      start(value) {
        controller = value;
      },
    }),
    writable: new WritableStream({
      write(bytes) {
        requests.push(new Uint8Array(bytes));
        const result = response(bytes, requests.length - 1);
        if (result !== undefined) send(result);
        if (options.writeError !== undefined) throw options.writeError;
      },
    }),
    async close() {
      closes++;
      if (!ended) {
        ended = true;
        controller.close();
      }
      if (options.closeError !== undefined) throw options.closeError;
    },
  };
  const config: RedisOptionsType = { openChannel: async () => channel };
  return { channel, config, requests, send, closes: () => closes };
}
const write: RedisPutType = { mode: "any", expiry: { kind: "persist" } };

describe("bounded Redis/Valkey native RESP2 byte commands", () => {
  it("preserves binary CRLF/NUL and empty keys and private binary values across single-byte framing", async () => {
    const original = new Uint8Array([0, 255, 13, 10, 128, 9]), key = new Uint8Array([0, 13, 10, 255]);
    const wire = peer(() => bulk(original), { fragment: true }), client = await openRedisClient(wire.config);
    try {
      const result = await client.get(key);
      expect(result).toEqual(original);
      expect(wire.requests[0]).toEqual(command("GET", key));
      result!.fill(1);
      expect(await client.get(new Uint8Array())).toEqual(original);
      expect(wire.requests[1]).toEqual(encode("*2\r\n$3\r\nGET\r\n$0\r\n\r\n"));
    } finally {
      await client.close();
    }
    expect(wire.closes()).toBe(1);
  });
  it("distinguishes missing GET from an existing empty value and refuses unrelated scalar receipts", async () => {
    const replies = ["$-1\r\n", "$0\r\n\r\n", "+OK\r\n"];
    const wire = peer(() => encode(replies.shift()!)), client = await openRedisClient(wire.config);
    expect(await client.get(encode("key"))).toBeNull();
    expect(await client.get(encode("key"))).toEqual(new Uint8Array());
    await expect(client.get(encode("key"))).rejects.toBeInstanceOf(RedisProtocolError);
    expect(client.closed).toBe(true);
    expect(wire.closes()).toBe(1);
  });
  it("captures AUTH bytes, initialization choices and channel callback before asynchronous acquisition", async () => {
    const password = encode("password"), username = encode("user");
    const options = {
      auth: { password, username },
      database: 3,
      openChannel: async () => {
        password.fill(1);
        username.fill(2);
        options.database = 9;
        options.openChannel = async () => {
          throw new Error("new authority");
        };
        return wire.channel;
      },
    };
    const wire = peer(() => encode("+OK\r\n")), client = await openRedisClient(options);
    expect(wire.requests).toEqual([command("AUTH", "user", "password"), command("SELECT", "3")]);
    await client.close();
    const getterWire = peer(() => encode("+OK\r\n"));
    const secret = encode("original"),
      config = {
        ...getterWire.config,
        auth: {
          password: secret,
          get username() {
            secret.fill(0);
            return encode("user");
          },
        },
      };
    const getterClient = await openRedisClient(config);
    expect(getterWire.requests).toEqual([command("AUTH", "user", "original")]);
    await getterClient.close();
  });
  it("retires AUTH/SELECT failure and preserves independent adapter cleanup without echoing native secrets", async () => {
    for (const failed of [0, 1]) {
      const cleanup = new Error("owned cleanup");
      const wire = peer((_, index) => encode(index === failed ? "-WRONGPASS private-value\r\n" : "+OK\r\n"), {
        closeError: cleanup,
      });
      let caught: unknown;
      try {
        await openRedisClient({ ...wire.config, auth: { password: encode("private-value") }, database: 1 });
      } catch (reason) {
        caught = reason;
      }
      expect(caught).toBeInstanceOf(AggregateError);
      const failures = (caught as AggregateError).errors;
      expect(failures[0]).toBeInstanceOf(RedisError);
      expect(failures[0].message).not.toContain("private-value");
      expect(failures[1]).toBe(cleanup);
      expect(wire.requests.length).toBe(failed + 1);
      expect(wire.closes()).toBe(1);
    }
  });
  it("snapshots caller key/value before option getters and writes exact native mode/expiry modifiers", async () => {
    const key = encode("key"), value = new Uint8Array([0, 255, 13, 10]);
    const wire = peer(() => encode("+OK\r\n")), client = await openRedisClient(wire.config);
    const options: RedisPutType = {
      get mode(): RedisPutType["mode"] {
        key.fill(1);
        value.fill(2);
        return "absent";
      },
      expiry: { kind: "relative", milliseconds: 30000 },
    };
    expect(await client.put(key, value, options)).toEqual({ state: "stored" });
    expect(wire.requests[0]).toEqual(command("SET", "key", new Uint8Array([0, 255, 13, 10]), "NX", "PX", "30000"));
    await client.put(new Uint8Array(), new Uint8Array(), { mode: "present", expiry: { kind: "keep" } });
    expect(wire.requests[1]).toEqual(command("SET", "", "", "XX", "KEEPTTL"));
    await client.put(encode("key"), encode("next"), { mode: "any", expiry: { kind: "absolute", milliseconds: 1 } });
    expect(wire.requests[2]).toEqual(command("SET", "key", "next", "PXAT", "1"));
    await client.put(encode("key"), encode("next"), write);
    expect(wire.requests[3]).toEqual(command("SET", "key", "next"));
    await client.close();
  });
  it("returns native NX/XX refusal, lossless TTL observations and zero-or-one single-key DEL", async () => {
    const replies = ["$-1", "$-1", ":-2", ":-1", ":0", ":9223372036854775807", ":1", ":0"];
    const wire = peer(() => encode(replies.shift() + "\r\n")), client = await openRedisClient(wire.config);
    expect(await client.put(encode("key"), encode("v"), { ...write, mode: "absent" })).toEqual({ state: "not-stored" });
    expect(await client.put(encode("key"), encode("v"), { ...write, mode: "present" })).toEqual({
      state: "not-stored",
    });
    expect(await client.ttl(encode("key"))).toEqual({ state: "missing" });
    expect(await client.ttl(encode("key"))).toEqual({ state: "persistent" });
    expect(await client.ttl(encode("key"))).toEqual({ state: "remaining", milliseconds: "0" });
    expect(await client.ttl(encode("key"))).toEqual({ state: "remaining", milliseconds: "9223372036854775807" });
    expect(await client.remove(encode("key"))).toBe(true);
    expect(await client.remove(encode("key"))).toBe(false);
    expect(wire.requests.length).toBe(8);
    await client.close();
  });
  it("rejects input budgets, invalid expiry and pre-abort without dispatch or retiring an idle connection", async () => {
    const wire = peer(() => encode("+OK\r\n")), client = await openRedisClient({ ...wire.config, maxBytes: 8 });
    await expect(client.get(new Uint8Array(1025))).rejects.toBeInstanceOf(RangeError);
    await expect(client.put(encode("key"), new Uint8Array(9), write)).rejects.toBeInstanceOf(RangeError);
    for (
      const expiry of [
        { kind: "relative", milliseconds: 0 },
        { kind: "absolute", milliseconds: -1 },
        { kind: "relative", milliseconds: 1.1 },
        { kind: "absolute", milliseconds: Number.MAX_SAFE_INTEGER + 1 },
        { kind: "persist", milliseconds: 1 },
      ]
    ) expect(RedisExpirySchema.safeParse(expiry).success).toBe(false);
    const reason = new Error("cancelled before IO");
    await expect(client.get(encode("key"), { signal: AbortSignal.abort(reason) })).rejects.toBe(reason);
    expect(wire.requests).toEqual([]);
    expect(client.closed).toBe(false);
    await client.close();
  });
  it("refuses unsupported, lossy and malformed reply framing and retires each connection", async () => {
    for (
      const response of [
        "$-2\r\n",
        "$01\r\n",
        "$1e0\r\n",
        "$9223372036854775808\r\n",
        "$1048577\r\n",
        "$1\r\na\rX",
        "$1\r\na\r\n+OK\r\n",
        "$0\n\n",
        "*-1\r\n",
        "_\r\n",
      ]
    ) {
      const wire = peer(() => encode(response)), client = await openRedisClient(wire.config);
      await expect(client.get(encode("key"))).rejects.toBeInstanceOf(RedisProtocolError);
      expect(client.closed).toBe(true);
      expect(wire.closes()).toBe(1);
    }
    for (const response of [":-0", ":01", ":-3", ":9223372036854775808", ":1.0"]) {
      const wire = peer(() => encode(response + "\r\n")), client = await openRedisClient(wire.config);
      await expect(client.ttl(encode("key"))).rejects.toBeInstanceOf(RedisProtocolError);
      expect(client.closed).toBe(true);
    }
  });
  it("labels dispatched uncertain mutations without retry and preserves known refusals plus cleanup", async () => {
    const transport = new Error("transport failure"), cleanup = new Error("cleanup failure");
    const lost = peer(() => undefined, { writeError: transport, closeError: cleanup });
    const client = await openRedisClient(lost.config);
    let caught: unknown;
    try {
      await client.put(encode("key"), encode("value"), write);
    } catch (reason) {
      caught = reason;
    }
    expect(caught).toBeInstanceOf(AggregateError);
    const failures = (caught as AggregateError).errors;
    expect(failures[0]).toBeInstanceOf(RedisPublicationError);
    expect(failures[0].cause).toBe(transport);
    expect(failures[1]).toBe(cleanup);
    expect(lost.requests.length).toBe(1);
    const refused = peer(() => encode("-READONLY forbidden secret\r\n"), { closeError: cleanup });
    const denied = await openRedisClient(refused.config);
    let refusal: unknown;
    try {
      await denied.remove(encode("key"));
    } catch (reason) {
      refusal = reason;
    }
    expect(refusal).toBeInstanceOf(AggregateError);
    const errors = (refusal as AggregateError).errors;
    expect(errors[0]).toBeInstanceOf(RedisError);
    expect(errors[0]).not.toBeInstanceOf(RedisPublicationError);
    expect(errors[0].message).not.toContain("secret");
    expect(errors[1]).toBe(cleanup);
  });
  it("does not confuse unconditional SET null or a multi-key DEL count with an acknowledgement", async () => {
    const nil = peer(() => encode("$-1\r\n")), client = await openRedisClient(nil.config);
    await expect(client.put(encode("key"), encode("v"), write)).rejects.toBeInstanceOf(RedisPublicationError);
    const many = peer(() => encode(":2\r\n")), removed = await openRedisClient(many.config);
    await expect(removed.remove(encode("key"))).rejects.toBeInstanceOf(RedisPublicationError);
  });
  it("enforces deadlines, busy refusal and shared close without an implicit command queue", async () => {
    // Node's AbortSignal.timeout is unreferenced; the fixture owns a bounded event-loop keeper.
    const keeper = setTimeout(() => {}, 500);
    try {
      const wire = peer(() => undefined), client = await openRedisClient({ ...wire.config, timeoutMs: 20 });
      const pending = client.get(encode("key"));
      await expect(client.get(encode("other"))).rejects.toThrow("busy");
      await expect(pending).rejects.toThrow();
      expect(wire.closes()).toBe(1);
      expect(wire.requests.length).toBe(1);
      const idle = peer(() => undefined), next = await openRedisClient(idle.config);
      const a = next.close(), b = next[Symbol.asyncDispose]();
      expect(a).toBe(b);
      await Promise.all([a, b]);
      expect(idle.closes()).toBe(1);
    } finally {
      clearTimeout(keeper);
    }
  });
  it("bounds chunk/progress/line materialization and releases partial initialization resources", async () => {
    const chunk = peer(() => new Uint8Array(65_537)), client = await openRedisClient(chunk.config);
    await expect(client.get(encode("key"))).rejects.toThrow("chunk");
    const line = peer(() => encode("+" + "x".repeat(1024) + "\r\n")), long = await openRedisClient(line.config);
    await expect(long.get(encode("key"))).rejects.toThrow("line");
    const empty = peer(() => undefined), stalled = await openRedisClient(empty.config);
    const pending = stalled.get(encode("key"));
    for (let i = 0; i < 17; i++) empty.send(new Uint8Array());
    await expect(pending).rejects.toThrow("progress");
    const setup = peer(() => undefined);
    const reader = setup.channel.readable.getReader();
    const unopened = new RedisClient(setup.config);
    await expect(unopened.open()).rejects.toThrow();
    expect(setup.closes()).toBe(1);
    reader.releaseLock();
  });
  it("retires a channel when a structural stream getter aborts initialization without AUTH or SELECT", async () => {
    const wire = peer(() => undefined),
      abort = new AbortController(),
      reason = new Error("abort during stream capture");
    const channel: RedisChannelType = {
      get readable() {
        abort.abort(reason);
        return wire.channel.readable;
      },
      writable: wire.channel.writable,
      close: wire.channel.close,
    };
    await expect(openRedisClient({ openChannel: async () => channel, signal: abort.signal })).rejects.toBe(reason);
    expect(wire.closes()).toBe(1);
    expect(wire.requests).toEqual([]);
    expect(wire.channel.readable.locked).toBe(false);
    expect(wire.channel.writable.locked).toBe(false);
  });
});
