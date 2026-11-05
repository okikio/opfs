import { it } from "node:test";
import { readFileSync } from "node:fs";
import { env } from "node:process";
import { expect } from "@std/expect";
import { NatsClient, NatsError } from "../src/nats.ts";
import { close } from "../src/close.ts";
import { openNats } from "./provider/nats.ts";
import { expectBytes } from "./reliability.ts";

it(
  "qualifies the selected native JetStream profile against the independent official SDK",
  { timeout: 240000 },
  async () => {
    const suppliedWheel = env.OPFS_NATS_ORACLE_WHEEL;
    const fixture = await openNats(suppliedWheel === undefined ? undefined : readFileSync(suppliedWheel));
    let counter = 0;
    const request = () => ({ inbox: `_INBOX.fixture.${++counter}` });
    const failures: unknown[] = [];
    try {
      const client = new NatsClient({ openChannel: fixture.openChannel.bind(fixture), auth: fixture.auth });
      for (
        const original of [
          new Uint8Array([0, 255, 13, 10, 128, 9]),
          Uint8Array.from({ length: 131072 }, (_, i) => i * 31 % 251),
        ]
      ) {
        const sequence = await fixture.seed(original);
        const stored = await client.get("OWNED", sequence, request());
        expect(stored.sequence).toBe(sequence);
        expect(stored.subject).toBe("owned.data");
        expectBytes(stored.bytes, original);
        const published = await client.publish("OWNED", "owned.data", original, {
          ...request(),
          messageId: `owned-${counter}`,
        });
        expect(published.duplicate).toBe(false);
        expectBytes(await fixture.read(published.sequence), original);
        const duplicate = await client.publish("OWNED", "owned.data", original, {
          ...request(),
          messageId: `owned-${counter - 1}`,
        });
        expect(duplicate.duplicate).toBe(true);
        expect(duplicate.sequence).toBe(published.sequence);
      }
      await expect(client.publish("OWNED", "other.data", new Uint8Array([1]), request())).rejects.toBeInstanceOf(
        NatsError,
      );
      expect(await fixture.otherCount()).toBe("0");
      await expect(client.get("OWNED", "18446744073709551615", request())).rejects.toBeInstanceOf(NatsError);
      const denied = new NatsClient({
        openChannel: fixture.openChannel.bind(fixture),
        auth: { user: "opfs", password: "wrong" },
      });
      await expect(denied.get("OWNED", "1", request())).rejects.toBeInstanceOf(NatsError);
    } catch (reason) {
      failures.push(reason);
      throw reason;
    } finally {
      await close([() => fixture.close()], failures);
    }
  },
);
