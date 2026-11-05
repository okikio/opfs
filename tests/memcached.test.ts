import { describe, it } from "node:test";
import { expect } from "@std/expect";
import {
  MemcachedError,
  MemcachedExpirySchema,
  MemcachedProtocolError,
  MemcachedPublicationError,
  openMemcachedClient,
} from "../src/memcached.ts";
import type { MemcachedChannelType, MemcachedOptionsType, MemcachedPutType } from "../src/memcached.ts";
const encode = (value: string): Uint8Array<ArrayBuffer> => new TextEncoder().encode(value);
function join(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const result = new Uint8Array(parts.reduce((size, bytes) => size + bytes.length, 0));
  let offset = 0;
  for (const bytes of parts) {
    result.set(bytes, offset);
    offset += bytes.length;
  }
  return result;
}
/** Independent wire producer uses literal ASCII framing and arbitrary opaque value bytes. */
function item(
  value = new Uint8Array([0, 255, 13, 10, 128, 9]),
  key = "key",
  token = "18446744073709551615",
): Uint8Array<ArrayBuffer> {
  return join(encode(`VALUE ${key} 4294967295 ${value.length} ${token}\r\n`), value, encode("\r\nEND\r\n"));
}
function peer(
  reply: (request: Uint8Array) => Uint8Array | undefined,
  options: { fragment?: boolean; closeError?: unknown } = {},
) {
  let controller!: ReadableStreamDefaultController<Uint8Array>, closes = 0, retired = false;
  const requests: Uint8Array[] = [];
  const send = (bytes: Uint8Array) => {
    if (options.fragment) { for (const byte of bytes) controller.enqueue(new Uint8Array([byte])); }
    else controller.enqueue(bytes);
  };
  const channel: MemcachedChannelType = {
    readable: new ReadableStream({
      start(c) {
        controller = c;
      },
    }),
    writable: new WritableStream({
      write(bytes) {
        requests.push(new Uint8Array(bytes));
        const response = reply(bytes);
        if (response !== undefined) send(response);
      },
    }),
    async close() {
      closes++;
      if (!retired) {
        retired = true;
        controller.close();
      }
      if (options.closeError !== undefined) throw options.closeError;
    },
  };
  const config: MemcachedOptionsType = { openChannel: async () => channel };
  return { config, channel, requests, send, closes: () => closes };
}
const write: MemcachedPutType = { mode: "set", flags: 0, expiry: { kind: "relative", seconds: 0 } };

describe("native Memcached classic ASCII cache commands", () => {
  it("reads exact binary bytes across single-byte framing with lossless uint64 CAS/uint32 flags", async () => {
    const original = new Uint8Array([0, 255, 13, 10, 128, 9]), wire = peer(() => item(original), { fragment: true });
    const client = await openMemcachedClient(wire.config);
    try {
      const result = await client.get("key");
      expect(result?.bytes).toEqual(original);
      expect(result?.flags).toBe(4294967295);
      expect(result?.cas).toBe("18446744073709551615");
      expect(wire.requests).toEqual([encode("gets key\r\n")]);
      result!.bytes.fill(1);
      expect((await client.get("key"))?.bytes).toEqual(original);
    } finally {
      await client.close();
    }
    expect(wire.closes()).toBe(1);
  });
  it("distinguishes existing empty values from native misses and rejects extra item replies", async () => {
    const empty = peer(() => item(new Uint8Array()));
    const client = await openMemcachedClient(empty.config);
    expect((await client.get("key"))?.bytes).toEqual(new Uint8Array());
    await client.close();
    const missing = peer(() => encode("END\r\n")), absent = await openMemcachedClient(missing.config);
    expect(await absent.get("key")).toBeNull();
    await absent.close();
    const extra = peer(() => join(item(), encode("END\r\n"))), invalid = await openMemcachedClient(extra.config);
    await expect(invalid.get("key")).rejects.toThrow("Unsolicited");
    expect(invalid.closed).toBe(true);
  });
  it("snapshots bytes/options before asynchronous transport and preserves native mode/expiry semantics", async () => {
    const bytes = new Uint8Array([0, 255, 13, 10]);
    const options = {
      mode: "cas" as const,
      cas: "9007199254740993",
      flags: 4294967295,
      expiry: { kind: "absolute" as const, seconds: 2_000_000_000 },
    };
    const wire = peer((request) => {
      bytes.fill(9);
      options.cas = "1";
      options.flags = 0;
      options.expiry.seconds = 1_900_000_000;
      expect(request).toEqual(
        join(
          encode("cas key 4294967295 2000000000 4 9007199254740993\r\n"),
          new Uint8Array([0, 255, 13, 10]),
          encode("\r\n"),
        ),
      );
      return encode("STORED\r\n");
    });
    const client = await openMemcachedClient(wire.config);
    expect(await client.put("key", bytes, options)).toEqual({ state: "stored" });
    await client.close();
  });
  it("returns acknowledged native storage conditions and unconditional deletion without retry", async () => {
    const replies = ["NOT_STORED", "EXISTS", "NOT_FOUND", "DELETED", "NOT_FOUND", "NOT_STORED"];
    const wire = peer(() => encode(replies.shift() + "\r\n")), client = await openMemcachedClient(wire.config);
    expect(await client.put("key", encode("a"), { ...write, mode: "add" })).toEqual({ state: "not-stored" });
    expect(await client.put("key", encode("b"), { ...write, mode: "cas", cas: "1" })).toEqual({ state: "exists" });
    expect(await client.put("key", encode("b"), { ...write, mode: "cas", cas: "1" })).toEqual({ state: "missing" });
    expect(await client.remove("key")).toBe(true);
    expect(await client.remove("key")).toBe(false);
    expect(await client.put("key", encode("b"), write)).toEqual({ state: "not-stored" });
    expect(wire.requests.length).toBe(6);
    await client.close();
  });
  it("rejects delimiter injection, invalid expiry/flags/CAS and value budgets before IO", async () => {
    const wire = peer(() => encode("STORED\r\n")), client = await openMemcachedClient({ ...wire.config, maxBytes: 8 });
    for (const key of ["", "a b", "a\r\ndelete other", "雪", "a".repeat(251)]) {
      await expect(client.get(key)).rejects.toThrow();
    }
    for (const cas of ["0", "01", "18446744073709551616", "1\r\n"]) {
      await expect(client.put("key", encode("a"), { ...write, mode: "cas", cas })).rejects.toThrow();
    }
    for (
      const expiry of [{ kind: "relative", seconds: 2_592_001 }, { kind: "absolute", seconds: 2_592_000 }, {
        kind: "relative",
        seconds: -1,
      }]
    ) expect(MemcachedExpirySchema.safeParse(expiry).success).toBe(false);
    await expect(client.put("key", encode("a"), { ...write, flags: 4294967296 })).rejects.toThrow();
    await expect(client.put("key", new Uint8Array(9), write)).rejects.toThrow();
    expect(MemcachedExpirySchema.safeParse({ kind: "absolute", seconds: 2_147_483_647 }).success).toBe(true);
    expect(MemcachedExpirySchema.safeParse({ kind: "absolute", seconds: 2_147_483_648 }).success).toBe(false);
    await expect(client.put("key", encode("a"), { ...write, expiry: { kind: "absolute", seconds: 2_147_483_648 } }))
      .rejects.toThrow("expiry");
    expect(wire.requests.length).toBe(0);
    expect(client.closed).toBe(false);
    await client.close();
  });
  it("refuses unbounded/inconsistent declared replies before value allocation and retires the stream", async () => {
    for (
      const response of [
        "VALUE key 0 9999999999 1\r\n",
        "VALUE other 0 1 1\r\nx\r\nEND\r\n",
        "VALUE key 0 01 1\r\nx\r\nEND\r\n",
        "VALUE key 0 1 18446744073709551616\r\nx\r\nEND\r\n",
        "VALUE key 4294967296 1 1\r\nx\r\nEND\r\n",
        "VALUE key 0 1 1\nx\r\nEND\r\n",
        "VALUE key 0 1 1\r\nx\r\nVALUE key 0 0 2\r\n\r\nEND\r\n",
      ]
    ) {
      const wire = peer(() => encode(response)), client = await openMemcachedClient(wire.config);
      await expect(client.get("key")).rejects.toBeInstanceOf(MemcachedProtocolError);
      expect(client.closed).toBe(true);
      expect(wire.closes()).toBe(1);
    }
  });
  it("keeps known native refusal distinct from uncertain mutation even if owned close fails", async () => {
    const cleanup = new Error("owned close failed"),
      wire = peer(() => encode("SERVER_ERROR untrusted secret\r\n"), { closeError: cleanup });
    const client = await openMemcachedClient(wire.config);
    try {
      await client.put("key", encode("a"), write);
      throw new Error("expected refusal");
    } catch (reason) {
      expect(reason).toBeInstanceOf(AggregateError);
      const errors = (reason as AggregateError).errors;
      expect(errors[0]).toBeInstanceOf(MemcachedError);
      expect(errors[0]).not.toBeInstanceOf(MemcachedPublicationError);
      expect(errors[0].message).not.toContain("secret");
      expect(errors[1]).toBe(cleanup);
    }
    expect(client.closed).toBe(true);
  });
  it("classifies malformed post-dispatch acknowledgements as unknown and never reuses their connection", async () => {
    for (const response of ["EXISTS\r\n", "STORED\r\nEND\r\n", "garbage\r\n"]) {
      const wire = peer(() => encode(response)), client = await openMemcachedClient(wire.config);
      await expect(client.put("key", encode("a"), write)).rejects.toBeInstanceOf(MemcachedPublicationError);
      expect(wire.requests.length).toBe(1);
      expect(client.closed).toBe(true);
      await expect(client.get("key")).rejects.toThrow("closed");
    }
  });
  it("rejects concurrent commands without cancelling the admitted request and shares one explicit close", async () => {
    const wire = peer(() => undefined), client = await openMemcachedClient(wire.config);
    const first = client.get("key");
    await expect(client.get("other")).rejects.toThrow("busy");
    wire.send(encode("END\r\n"));
    expect(await first).toBeNull();
    const closing = client.close();
    expect(client[Symbol.asyncDispose]()).toBe(closing);
    await closing;
    expect(wire.closes()).toBe(1);
  });
  it("preabort performs no acquisition or write; post-dispatch cancellation retires and retains cause", async () => {
    const reason = new Error("caller abort"), already = AbortSignal.abort(reason);
    let acquisitions = 0;
    await expect(openMemcachedClient({
      signal: already,
      openChannel: async () => {
        acquisitions++;
        throw new Error("unexpected");
      },
    })).rejects.toBe(reason);
    expect(acquisitions).toBe(0);
    const wire = peer(() => undefined), client = await openMemcachedClient(wire.config), abort = new AbortController();
    const promise = client.put("key", encode("a"), { ...write, signal: abort.signal });
    abort.abort(reason);
    try {
      await promise;
      throw new Error("expected cancellation");
    } catch (failure) {
      expect(failure).toBeInstanceOf(MemcachedPublicationError);
      expect((failure as Error).cause).toBe(reason);
    }
    expect(client.closed).toBe(true);
    expect(wire.closes()).toBe(1);
  });
  it("bounds command and cleanup waits while preserving a shared cleanup failure", async () => {
    const keeper = setTimeout(() => {}, 200);
    try {
      const wire = peer(() => undefined), client = await openMemcachedClient({ ...wire.config, timeoutMs: 5 });
      await expect(client.get("key")).rejects.toThrow();
      expect(client.closed).toBe(true);
      expect(wire.closes()).toBe(1);
      const stuck = peer(() => encode("END\r\n"));
      const closed = await openMemcachedClient({
        ...stuck.config,
        cleanupMs: 5,
        openChannel: async () => ({ ...stuck.channel, close: () => new Promise(() => {}) }),
      });
      const first = closed.close();
      await expect(first).rejects.toThrow();
      expect(closed.close()).toBe(first);
      expect(stuck.channel.readable.locked).toBe(false);
      expect(stuck.channel.writable.locked).toBe(false);
    } finally {
      clearTimeout(keeper);
    }
  });
  it("owns acquired channels through partial stream setup and captures their close method once", async () => {
    const wire = peer(() => encode("END\r\n")), held = wire.channel.writable.getWriter();
    await expect(openMemcachedClient(wire.config)).rejects.toThrow();
    expect(wire.closes()).toBe(1);
    expect(wire.channel.readable.locked).toBe(false);
    held.releaseLock();
    const next = peer(() => encode("END\r\n")), client = await openMemcachedClient(next.config);
    next.channel.close = async () => {
      throw new Error("mutated close authority");
    };
    await client.close();
    expect(next.closes()).toBe(1);
  });
});
