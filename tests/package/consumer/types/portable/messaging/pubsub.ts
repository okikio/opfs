/** Compile-only installed messaging pubsub contracts; never execute these expressions. */
import { createPubsubClient, PubsubDeliverySchema } from "@okikio/opfs/pubsub";

const pubsubTyped: import("@okikio/opfs/pubsub").PubsubClient = createPubsubClient({
  endpoint: "https://pubsub.googleapis.com/",
  project: "type-only",
  fetch,
});
const pubsubDeliveryTyped: readonly import("@okikio/opfs/pubsub").PubsubDeliveryType[] = await pubsubTyped.pull(
  "subscription",
  { maxMessages: 1 },
);
void pubsubDeliveryTyped;
void PubsubDeliverySchema;
