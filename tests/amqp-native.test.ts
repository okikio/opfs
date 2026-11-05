import { describe, it } from "node:test";
import { expect } from "@std/expect";
import { AmqpClient } from "../src/amqp.ts";
import { createAmqpReplay, prepareAmqpReplay } from "./fixtures/amqp/replay.ts";

describe("unchanged native RabbitMQ frames", () => {
  for (const fragmented of [false, true]) {
    it(`takes independent Pika bytes with fragmented=${fragmented}`, async () => {
      const native = await prepareAmqpReplay();
      const client = new AmqpClient({
        openChannel: async () => createAmqpReplay(native.take, fragmented),
        auth: { user: "fixture", password: "fixture-only-amqp" },
        vhost: "/owned",
        allowPlaintext: true,
      });
      const message = await client.take("owned", { autoAck: true });
      expect(message).not.toBeNull();
      expect(message!.bytes).toEqual(native.original);
      expect(message!.exchange).toBe("owned");
      expect(message!.routingKey).toBe("key");
    });
    it(`publishes the independently consumed original with fragmented=${fragmented}`, async () => {
      const native = await prepareAmqpReplay();
      const client = new AmqpClient({
        openChannel: async () => createAmqpReplay(native.publish, fragmented),
        auth: { user: "fixture", password: "fixture-only-amqp" },
        vhost: "/owned",
        allowPlaintext: true,
      });
      expect(await client.publish("owned", "key", native.original)).toEqual({ confirmation: "ack", requeue: false });
    });
  }
});
