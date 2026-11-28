/** Project retained messaging oracles into the disposable installed consumer. */
import { readFile } from "node:fs/promises";

/** Preserve producer selections and original JSON text where numeric lexemes are evidence. */
export async function messagingFixtures(): Promise<Record<string, unknown>> {
  return {
    "messaging/pubsub.json": JSON.parse(
      await readFile(new URL("../../fixtures/pubsub/independent.json", import.meta.url), "utf8"),
    ),
    "messaging/amqp.json": JSON.parse(
      await readFile(new URL("../../fixtures/amqp/independent.json", import.meta.url), "utf8"),
    ),
    "messaging/nats.json": JSON.parse(
      await readFile(new URL("../../fixtures/nats/independent.json", import.meta.url), "utf8"),
    ),
    "messaging/redis.json": JSON.parse(
      await readFile(new URL("../../fixtures/redis/independent.json", import.meta.url), "utf8"),
    ),
    "messaging/memcached.json": JSON.parse(
      await readFile(new URL("../../fixtures/memcached/independent.json", import.meta.url), "utf8"),
    ),
  };
}
