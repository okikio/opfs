/** Compile-only installed messaging amqp contracts; never execute these expressions. */
import { AmqpClient } from "@okikio/opfs/amqp";

const amqpTyped = new AmqpClient({
  openChannel: async () => {
    throw new Error("type-only");
  },
  auth: { user: "fixture", password: "fixture" },
  vhost: "/owned",
});
const amqpReceiptTyped: import("@okikio/opfs/amqp").AmqpReceiptType = await amqpTyped.publish(
  "owned",
  "key",
  new Uint8Array(),
);
const amqpMessageTyped: import("@okikio/opfs/amqp").AmqpMessageType | null = await amqpTyped.take("owned", {
  autoAck: true,
});
void amqpReceiptTyped;
void amqpMessageTyped;
