/** Installed messaging pubsub contracts. Each case owns its state and exact source oracle. */
import { describe, it } from "node:test";
import { createPubsubClient, PubsubDeliverySchema } from "@okikio/opfs/pubsub";
import { assertBytes, fromBase64 } from "../../bytes.mjs";
import pubsubInput from "../../data/messaging/pubsub.json" with { type: "json" };

describe("packed messaging pubsub", () => {
  it("Pub/Sub delivery identity and acknowledgement", async () => {
    const pubsubFixture = pubsubInput;
    let pubsubCalls = 0;
    const pubsubClient = createPubsubClient({
      endpoint: "https://pubsub-package.invalid/",
      project: pubsubFixture.project,
      fetch: async (input, init) => {
        if (init.method !== "POST" || init.redirect !== "manual" || init.credentials !== "omit") {
          throw new Error("Packed Pub/Sub request policy changed");
        }
        const target = new URL(String(input)),
          body = JSON.parse(init.body),
          operation = target.pathname.split(":").at(-1);
        if (
          target.pathname !==
            ("/v1/projects/" + pubsubFixture.project + "/subscriptions/" + pubsubFixture.subscription + ":" + operation)
        ) throw new Error("Packed Pub/Sub subscription scope changed");
        const captured = operation === "pull"
          ? pubsubFixture.pull
          : operation === "modifyAckDeadline"
          ? pubsubFixture.deadline
          : operation === "acknowledge"
          ? pubsubFixture.acknowledge
          : undefined;
        if (!captured) throw new Error("Uncaptured packed Pub/Sub request");
        const native = JSON.parse(new TextDecoder().decode(fromBase64(pubsubFixture.pull.base64))).receivedMessages[0];
        if (operation === "pull") { if (body.maxMessages !== 1) throw new Error("Packed Pub/Sub pull bound changed"); }
        else if (body.ackIds.length !== 1 || body.ackIds[0] !== native.ackId) {
          throw new Error("Packed Pub/Sub delivery token changed");
        }
        if (operation === "modifyAckDeadline" && body.ackDeadlineSeconds !== 30) {
          throw new Error("Packed Pub/Sub explicit deadline changed");
        }
        pubsubCalls++;
        return new Response(fromBase64(captured.base64), { status: captured.status, headers: captured.headers });
      },
    });
    const pubsubDeliveries = await pubsubClient.pull(pubsubFixture.subscription, { maxMessages: 1 });
    const pubsubNative =
      JSON.parse(new TextDecoder().decode(fromBase64(pubsubFixture.pull.base64))).receivedMessages[0];
    if (
      pubsubDeliveries.length !== 1 || pubsubDeliveries[0].messageId !== pubsubFixture.messageId ||
      pubsubDeliveries[0].publishTime !== pubsubNative.message.publishTime
    ) throw new Error("Packed Pub/Sub native identity or timestamp changed");
    assertBytes(pubsubDeliveries[0].bytes, fromBase64(pubsubFixture.oracle.base64));
    PubsubDeliverySchema.parse(pubsubDeliveries[0]);
    await pubsubClient.modifyAckDeadline(pubsubFixture.subscription, [pubsubDeliveries[0].ackId], 30);
    await pubsubClient.acknowledge(pubsubFixture.subscription, [pubsubDeliveries[0].ackId]);
    if (pubsubCalls !== 3) throw new Error("Packed Pub/Sub performed hidden operations");
  });
});
