import { describe, it } from "node:test";
import { expect } from "@std/expect";
import { close } from "../src/close.ts";
import { openRedisClient, RedisError } from "../src/redis.ts";
import { expectBytes } from "./reliability.ts";
import { openRedis } from "./provider/redis.ts";

describe("separate native Redis and Valkey RESP2 qualification", () => {
  for (const kind of ["redis", "valkey"] as const) {
    it(
      `compares complete independent SDK/CLI bytes and native conditions on ${kind}`,
      { timeout: 240_000 },
      async () => {
        const fixture = await openRedis(kind), clients: (() => Promise<void>)[] = [];
        let primary: unknown[] = [];
        try {
          const config = { openChannel: fixture.openChannel.bind(fixture), auth: fixture.auth, database: 3 };
          await expect(openRedisClient({ ...config, auth: { password: new TextEncoder().encode("wrong") } }))
            .rejects.toBeInstanceOf(RedisError);
          const unauthenticated = await openRedisClient({ openChannel: config.openChannel });
          clients.push(() => unauthenticated.close());
          await expect(unauthenticated.get(new Uint8Array())).rejects.toBeInstanceOf(RedisError);
          const client = await openRedisClient(config);
          clients.push(() => client.close());
          const key = new Uint8Array([0, 13, 10, 255]), original = new Uint8Array(131072);
          for (let index = 0; index < original.length; index++) original[index] = index * 31 & 255;
          await fixture.seed(key, original);
          // Independent hiredis producer -> candidate full-byte consumer.
          expectBytes((await client.get(key))!, original);
          const replacement = new Uint8Array(original.map((byte) => byte ^ 170));
          expect(await client.put(key, replacement, { mode: "present", expiry: { kind: "persist" } }))
            .toEqual({ state: "stored" });
          // Candidate producer -> independent hiredis full-byte consumer.
          expectBytes((await fixture.read(key)).bytes!, replacement);
          expect(await client.put(key, original, { mode: "absent", expiry: { kind: "persist" } }))
            .toEqual({ state: "not-stored" });
          expectBytes((await fixture.read(key)).bytes!, replacement);
          fixture.seedCli(kind, original);
          // Bundled native CLI producer -> candidate full-byte consumer.
          expectBytes((await client.get(new TextEncoder().encode("cli-owned-key")))!, original);
          const empty = new Uint8Array();
          expect(await client.put(empty, empty, { mode: "absent", expiry: { kind: "keep" } }))
            .toEqual({ state: "stored" });
          expect(await client.get(empty)).toEqual(empty);
          expect((await fixture.read(empty)).bytes).toEqual(empty);
          expect(await client.ttl(empty)).toEqual({ state: "persistent" });
          await client.put(empty, original, { mode: "present", expiry: { kind: "relative", milliseconds: 300_000 } });
          const before = await client.ttl(empty);
          expect(before.state).toBe("remaining");
          await client.put(empty, replacement, { mode: "present", expiry: { kind: "keep" } });
          const after = await client.ttl(empty);
          expect(after.state).toBe("remaining");
          if (before.state !== "remaining" || after.state !== "remaining") throw new Error("Native TTL is missing.");
          expect(BigInt(after.milliseconds) > 0n).toBe(true);
          expect(BigInt(after.milliseconds) <= BigInt(before.milliseconds)).toBe(true);
          expectBytes((await fixture.read(empty)).bytes!, replacement);
          await client.put(empty, empty, { mode: "any", expiry: { kind: "persist" } });
          expect(await client.ttl(empty)).toEqual({ state: "persistent" });
          expect((await fixture.read(empty)).ttl).toBe("-1");
          expect(await client.put(empty, original, { mode: "any", expiry: { kind: "absolute", milliseconds: 1 } }))
            .toEqual({ state: "stored" });
          expect(await client.get(empty)).toBeNull();
          expect(await client.ttl(empty)).toEqual({ state: "missing" });
          expect(await client.put(empty, original, { mode: "present", expiry: { kind: "persist" } }))
            .toEqual({ state: "not-stored" });
          expect(await client.remove(key)).toBe(true);
          expect(await client.remove(key)).toBe(false);
          expect((await fixture.read(key)).bytes).toBeNull();
        } catch (reason) {
          primary = [reason];
        } finally {
          await close([...clients.reverse(), () => fixture.close()], primary);
        }
      },
    );
  }
});
