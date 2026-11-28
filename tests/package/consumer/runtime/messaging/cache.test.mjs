/** Installed messaging cache contracts. Each case owns its state and exact source oracle. */
import { describe, it } from "node:test";
import { MemcachedExpirySchema, openMemcachedClient } from "@okikio/opfs/memcached";
import { openRedisClient, RedisExpirySchema } from "@okikio/opfs/redis";
import { assertBytes, fromBase64 } from "../../bytes.mjs";
import redisInput from "../../data/messaging/redis.json" with { type: "json" };
import memcachedInput from "../../data/messaging/memcached.json" with { type: "json" };

describe("packed messaging cache", () => {
  it("native Redis commands, TTL and owned close", async () => {
    const redisFixture = redisInput;
    // Replay each unchanged native response through a fresh exclusive byte channel.
    // Request expectations use independent RESP2 framing, never the client encoder.
    /** Encode the independently authored RESP2 command text. */
    const redisText = (value) => new TextEncoder().encode(value);
    /** Frame expected RESP2 requests independently of the installed client encoder. */
    const redisRequest = (parts) => {
      const bytes = parts.map((value) => typeof value === "string" ? redisText(value) : value);
      const chunks = [redisText("*" + bytes.length + "\r\n")];
      for (const value of bytes) chunks.push(redisText("$" + value.length + "\r\n"), value, redisText("\r\n"));
      const output = new Uint8Array(chunks.reduce((total, value) => total + value.length, 0));
      let at = 0;
      for (const value of chunks) {
        output.set(value, at);
        at += value.length;
      }
      return output;
    };
    for (const fixture of redisFixture.providers) {
      const key = fromBase64(fixture.key.base64), original = fromBase64(redisFixture.oracle.base64);
      const steps = [
        [redisRequest(["AUTH", "package-password"]), fixture.auth],
        [redisRequest(["SELECT", "3"]), fixture.select],
        [fromBase64(fixture.getRequest.base64), fixture.get],
        [redisRequest(["PTTL", key]), fixture.ttl],
        [redisRequest(["SET", key, original, "NX"]), fixture.refused],
        [redisRequest(["SET", key, original, "XX", "KEEPTTL"]), fixture.stored],
        [redisRequest(["DEL", key]), fixture.removed],
        [redisRequest(["DEL", key]), fixture.missing],
        [redisRequest(["PTTL", key]), fixture.missingTtl],
      ];
      let count = 0, closed = 0, controller;
      const client = await openRedisClient({
        auth: { password: redisText("package-password") },
        database: 3,
        openChannel: async () => ({
          readable: new ReadableStream({
            start(value) {
              controller = value;
            },
          }),
          writable: new WritableStream({
            write(bytes) {
              const step = steps[count++];
              if (!step) throw new Error("Packed Redis hidden command");
              assertBytes(bytes, step[0]);
              controller.enqueue(fromBase64(step[1].base64));
            },
          }),
          async close() {
            closed++;
            controller.close();
          },
        }),
      });
      try {
        assertBytes(await client.get(key), original);
        if ((await client.ttl(key)).state !== "persistent") throw new Error("Packed Redis persistent TTL changed");
        if ((await client.put(key, original, { mode: "absent", expiry: { kind: "persist" } })).state !== "not-stored") {
          throw new Error("Packed Redis NX receipt changed");
        }
        if ((await client.put(key, original, { mode: "present", expiry: { kind: "keep" } })).state !== "stored") {
          throw new Error("Packed Redis XX receipt changed");
        }
        if (!await client.remove(key) || await client.remove(key)) throw new Error("Packed Redis DEL receipt changed");
        if ((await client.ttl(key)).state !== "missing") throw new Error("Packed Redis missing TTL changed");
        RedisExpirySchema.parse({ kind: "absolute", milliseconds: 1 });
      } finally {
        if (!client.closed) await client.close();
      }
      if (count !== steps.length || closed !== 1) {
        throw new Error("Packed Redis command count or owned cleanup changed");
      }
    }
  });
  it("native Memcached values, expiry and channel ownership", async () => {
    const memcachedFixture = memcachedInput;
    const memcachedWire = Uint8Array.from(atob(memcachedFixture.get.base64), (byte) => byte.charCodeAt(0));
    const memcachedOriginal = Uint8Array.from(atob(memcachedFixture.oracle.base64), (byte) => byte.charCodeAt(0));
    let memcachedController, memcachedClosed = 0, memcachedWrites = 0;
    const memcached = await openMemcachedClient({
      openChannel: async () => ({
        readable: new ReadableStream({
          start(controller) {
            memcachedController = controller;
          },
        }),
        writable: new WritableStream({
          write(bytes) {
            assertBytes(bytes, new TextEncoder().encode("gets " + memcachedFixture.key + "\r\n"));
            memcachedWrites++;
            memcachedController.enqueue(memcachedWire);
          },
        }),
        close: async () => {
          memcachedClosed++;
          memcachedController.close();
        },
      }),
    });
    try {
      const item = await memcached.get(memcachedFixture.key);
      if (!item || item.cas !== memcachedFixture.cas || item.flags !== memcachedFixture.flags) {
        throw new Error("Packed Memcached native identity changed");
      }
      assertBytes(item.bytes, memcachedOriginal);
      if (
        !MemcachedExpirySchema.safeParse({ kind: "absolute", seconds: 2147483647 }).success ||
        MemcachedExpirySchema.safeParse({ kind: "absolute", seconds: 2147483648 }).success
      ) throw new Error("Packed Memcached expiry boundary changed");
    } finally {
      await memcached.close();
    }
    if (memcachedWrites !== 1 || memcachedClosed !== 1) throw new Error("Packed Memcached channel ownership changed");
  });
});
