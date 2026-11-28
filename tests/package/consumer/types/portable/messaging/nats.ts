/** Compile-only installed messaging nats contracts; never execute these expressions. */
import { NatsClient } from "@okikio/opfs/nats";

const natsTyped: NatsClient = new NatsClient({
  openChannel: async () => {
    throw new Error("type-only");
  },
});
const natsReceiptTyped: import("@okikio/opfs/nats").NatsReceiptType = await natsTyped.publish(
  "OWNED",
  "owned.data",
  new Uint8Array(),
  { inbox: "_INBOX.package.publish" },
);
const natsMessageTyped: import("@okikio/opfs/nats").NatsMessageType = await natsTyped.get(
  "OWNED",
  natsReceiptTyped.sequence,
  { inbox: "_INBOX.package.read" },
);
void natsMessageTyped;
