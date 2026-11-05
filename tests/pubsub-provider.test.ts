import { describe, it } from "node:test";
import { expect } from "@std/expect";
import { openPubsub } from "./provider/pubsub.ts";
import { createPubsubClient, PubsubError } from "../src/pubsub.ts";
import { expectBytes } from "./reliability.ts";
import { close } from "./close.ts";

describe("official Pub/Sub emulator with isolated official SDK", () => {
  it(
    "exchanges complete bytes and explicit delivery settlement without a filesystem projection",
    { timeout: 420000 },
    async () => {
      const fixture = await openPubsub();
      let primary: readonly unknown[] = [];
      try {
        const client = createPubsubClient({
          endpoint: fixture.endpoint,
          project: fixture.project,
          allowHttp: true,
          fetch: globalThis.fetch.bind(globalThis),
          timeoutMs: 15000,
        });
        const original = Uint8Array.from({ length: 131072 }, (_, index) => (index * 31 + 17) % 251);
        const ids = await fixture.seed(original),
          received = await client.pull(fixture.subscription, { maxMessages: 1 });
        expect(received.length).toBe(1);
        // Pub/Sub SDK→client full bytes.
        expectBytes(received[0]!.bytes, original);
        expect(received[0]!.messageId).toBe(ids[0]);
        await client.modifyAckDeadline(fixture.subscription, [received[0]!.ackId], 0);
        const redelivered = await fixture.pull();
        expect(redelivered).not.toBeNull();
        // Pub/Sub zero-deadline SDK redelivery.
        expectBytes(redelivered!.bytes, original);
        expect(redelivered!.messageId).toBe(ids[0]);
        await client.acknowledge(fixture.subscription, [redelivered!.ackId]);
        const changed = new Uint8Array(original);
        changed.reverse();
        const published = await client.publish(fixture.topic, [{
          bytes: changed,
          attributes: { oracle: "candidate" },
        }]);
        const independent = await fixture.pull();
        expect(independent).not.toBeNull();
        expect(independent!.messageId).toBe(published[0]);
        // Pub/Sub client→SDK full bytes.
        expectBytes(independent!.bytes, changed);
        await client.acknowledge(fixture.subscription, [independent!.ackId]);
        await expect(client.publish("missing-topic", [{ bytes: original }])).rejects.toBeInstanceOf(PubsubError);
        await expect(client.pull("missing-subscription", { maxMessages: 1 })).rejects.toBeInstanceOf(PubsubError);
      } catch (reason) {
        primary = [reason];
      } finally {
        await close([() => fixture.close()], primary);
      }
    },
  );
});
