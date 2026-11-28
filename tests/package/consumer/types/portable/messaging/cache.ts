/** Compile-only installed messaging cache contracts; never execute these expressions. */
import { MemcachedExpirySchema, openMemcachedClient } from "@okikio/opfs/memcached";
import { openRedisClient, RedisExpirySchema } from "@okikio/opfs/redis";

const memcachedTyped: import("@okikio/opfs/memcached").MemcachedClient = await openMemcachedClient({
  openChannel: async () => {
    throw new Error("type-only");
  },
});
const memcachedValue: import("@okikio/opfs/memcached").MemcachedEntryType | null = await memcachedTyped.get("key");
const memcachedExpiry: import("@okikio/opfs/memcached").MemcachedExpiryType = MemcachedExpirySchema.parse({
  kind: "relative",
  seconds: 0,
});
const memcachedReceipt: import("@okikio/opfs/memcached").MemcachedReceiptType = await memcachedTyped.put(
  "key",
  new Uint8Array(),
  { mode: "add", flags: 0, expiry: memcachedExpiry },
);
void memcachedValue;
void memcachedReceipt;
const redisTyped: import("@okikio/opfs/redis").RedisClient = await openRedisClient({
  openChannel: async () => {
    throw new Error("type-only");
  },
});
const redisValueTyped: Uint8Array | null = await redisTyped.get(new Uint8Array());
const redisReceiptTyped: import("@okikio/opfs/redis").RedisReceiptType = await redisTyped.put(
  new Uint8Array(),
  new Uint8Array(),
  { mode: "absent", expiry: { kind: "persist" } },
);
const redisTtlTyped: import("@okikio/opfs/redis").RedisTtlType = await redisTyped.ttl(new Uint8Array());
void redisValueTyped;
void redisReceiptTyped;
void redisTtlTyped;
void RedisExpirySchema;
