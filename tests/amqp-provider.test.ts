import { it } from "node:test";
import { readFileSync } from "node:fs";
import { Buffer } from "node:buffer";
import { env } from "node:process";
import { expect } from "@std/expect";
import { AmqpClient, AmqpError, AmqpOutcomeError } from "../src/amqp.ts";
import { expectBytes } from "./reliability.ts";
import { withAmqpFixture } from "./provider/amqp.ts";

it("qualifies the selected native AMQP profile with independent Pika full bytes", { timeout: 240000 }, async () => {
  const path = env.OPFS_AMQP_ORACLE_WHEEL;
  const wheel = path === undefined ? undefined : readFileSync(path);
  await withAmqpFixture(wheel, async (fixture) => {
    // Client construction is inside the fixture's owned callback, so any
    // constructor failure still releases sockets, containers and network.
    const client = new AmqpClient({
      openChannel: fixture.openChannel,
      auth: fixture.auth,
      vhost: fixture.vhost,
      allowPlaintext: true,
      timeoutMs: 15000,
    });
    for (
      const original of [
        new Uint8Array([0, 255, 13, 10, 128, 9]),
        Uint8Array.from({ length: 131072 }, (_, at) => at * 31 % 251),
      ]
    ) {
      const seeded = await fixture.seed(original);
      expect(seeded.confirmed).toBe(true);
      expect(seeded.bytes).toBe(original.length);
      const message = await client.take("owned", { autoAck: true });
      expect(message).not.toBeNull();
      expectBytes(message!.bytes, original);
      expect(message!.exchange).toBe("owned");
      expect(message!.routingKey).toBe("key");
      expect((await fixture.count()).messages).toBe("0");
      expect(await client.take("owned", { autoAck: true })).toBeNull();
      const publication = await client.publish("owned", "key", original);
      expect(publication).toEqual({ confirmation: "ack", requeue: false });
      const independent = await fixture.take();
      expect(independent.empty).toBe(false);
      expect(typeof independent.base64).toBe("string");
      expectBytes(new Uint8Array(Buffer.from(independent.base64 as string, "base64")), original);
      expect((await fixture.count()).messages).toBe("0");
    }
    const returnedBytes = new Uint8Array([0, 255, 13, 10, 128, 9]);
    const returned = await client.publish("owned", "missing-binding", returnedBytes);
    expect(returned.confirmation).toBe("ack");
    expect(returned.returned?.code).toBe(312);
    expect(returned.returned?.exchange).toBe("owned");
    expect(returned.returned?.routingKey).toBe("missing-binding");
    expectBytes(returned.returned!.bytes, returnedBytes);
    expect((await fixture.count()).messages).toBe("0");
    await expect(client.take("missing-queue", { autoAck: true })).rejects.toBeInstanceOf(AmqpOutcomeError);
    const denied = new AmqpClient({
      openChannel: fixture.openChannel,
      auth: { user: "fixture", password: "wrong" },
      vhost: fixture.vhost,
      allowPlaintext: true,
      timeoutMs: 15000,
    });
    await expect(denied.take("owned", { autoAck: true })).rejects.toBeInstanceOf(AmqpError);
    expect((await fixture.count()).messages).toBe("0");
    console.log(
      JSON.stringify({
        nativeFlow: "Pika→AMQP→Pika",
        fullByteSizes: [6, 131072],
        autoAckCount: "0",
        returnedCode: returned.returned!.code,
        confirmation: returned.confirmation,
      }),
    );
  });
});
