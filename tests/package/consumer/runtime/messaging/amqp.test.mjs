/** Installed messaging amqp contracts. Each case owns its state and exact source oracle. */
import { describe, it } from "node:test";
import { AmqpClient } from "@okikio/opfs/amqp";
import { assertBytes, fromBase64 } from "../../bytes.mjs";
import amqpInput from "../../data/messaging/amqp.json" with { type: "json" };

describe("packed messaging amqp", () => {
  it("native AMQP replay and channel ownership", async () => {
    const amqpNative = amqpInput;
    const amqpOriginal = fromBase64(amqpNative.oracle.base64);
    const amqpReleases = {
      take: [[0], [1], [], [2], [3], [4, 5, 6], [7]],
      publish: [[0], [1], [], [2], [3], [4], [], [], [5], [6]],
    };
    for (
      const record of [
        amqpNative.oracle,
        ...[amqpNative.take, amqpNative.publish].flatMap(
          (tape) => [tape.replyWire, ...tape.commands, ...tape.replyFrames],
        ),
      ]
    ) {
      const bytes = fromBase64(record.base64);
      const digest = Array.from(
        new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", bytes)),
        (byte) => byte.toString(16).padStart(2, "0"),
      ).join("");
      if (bytes.length !== record.bytes || digest !== record.sha256) {
        throw new Error("Packed native AMQP fixture identity changed");
      }
    }
    /** Replay frozen native frames after their expected commands; fragmentation must not change channel ownership. */
    const amqpReplay = (operation, fragmented) => {
      const tape = amqpNative[operation],
        commands = tape.commands.map((item) => fromBase64(item.base64)),
        replies = tape.replyFrames.map((item) => fromBase64(item.base64));
      let controller, at = 0, closed = false;
      return {
        security: "plaintext",
        readable: new ReadableStream({
          start(value) {
            controller = value;
          },
        }),
        writable: new WritableStream({
          write(bytes) {
            if (!commands[at]) throw new Error("Packed AMQP sent an extra command");
            assertBytes(bytes, commands[at]);
            for (const index of amqpReleases[operation][at++]) {
              if (fragmented) { for (const byte of replies[index]) controller.enqueue(new Uint8Array([byte])); }
              else controller.enqueue(new Uint8Array(replies[index]));
            }
          },
        }),
        async close() {
          if (closed) return;
          closed = true;
          controller.close();
          if (at !== commands.length) throw new Error("Packed AMQP omitted a native producer command");
        },
      };
    };
    for (const fragmented of [false, true]) {
      const reader = new AmqpClient({
        openChannel: async () => amqpReplay("take", fragmented),
        auth: { user: "fixture", password: "fixture-only-amqp" },
        vhost: "/owned",
        allowPlaintext: true,
      });
      const message = await reader.take("owned", { autoAck: true });
      if (!message || message.exchange !== "owned" || message.routingKey !== "key") {
        throw new Error("Packed AMQP native dequeue changed");
      }
      assertBytes(message.bytes, amqpOriginal);
      const writer = new AmqpClient({
        openChannel: async () => amqpReplay("publish", fragmented),
        auth: { user: "fixture", password: "fixture-only-amqp" },
        vhost: "/owned",
        allowPlaintext: true,
      });
      const receipt = await writer.publish("owned", "key", amqpOriginal);
      if (receipt.confirmation !== "ack" || receipt.requeue !== false || receipt.returned !== undefined) {
        throw new Error("Packed AMQP native confirmation changed");
      }
    }
  });
});
