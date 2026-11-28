/** Installed messaging nats contracts. Each case owns its state and exact source oracle. */
import { describe, it } from "node:test";
import { NatsClient } from "@okikio/opfs/nats";
import { assertBytes, fromBase64 } from "../../bytes.mjs";
import natsInput from "../../data/messaging/nats.json" with { type: "json" };

describe("packed messaging nats", () => {
  it("native NATS replay and publication receipt", async () => {
    const natsNative = natsInput;
    /** Encode exact expected NATS commands independently of the client transport. */
    const natsEncode = (value) => new TextEncoder().encode(value), natsCrlf = String.fromCharCode(13, 10);
    for (const operation of ["get", "publish"]) {
      const record = natsNative[operation], oracle = fromBase64(natsNative.oracle.base64);
      const authCommands = record.authControls.flatMap((control) => control.command ? [control.command] : []),
        replyCommands = record.controls.flatMap((control) => control.command ? [control.command] : []);
      let controller, stage = 0, authAt = 0, replyAt = 0, closes = 0;
      const channel = {
        security: "plaintext",
        readable: new ReadableStream({
          start(value) {
            controller = value;
            controller.enqueue(fromBase64(record.initial.base64));
          },
        }),
        writable: new WritableStream({
          write(value) {
            if (stage === 0) {
              assertBytes(
                value,
                natsEncode(
                  "CONNECT " +
                    JSON.stringify({
                      verbose: false,
                      pedantic: true,
                      protocol: 1,
                      headers: true,
                      no_responders: true,
                      lang: "typescript",
                      version: "opfs-nats/1",
                      user: "opfs",
                      pass: "fixture-only-nats",
                      tls_required: false,
                    }) + natsCrlf + "PING" + natsCrlf,
                ),
              );
              stage++;
              for (const control of record.authControls) controller.enqueue(fromBase64(control.response.base64));
              controller.enqueue(fromBase64(record.pong.base64));
            } else if (authAt < authCommands.length) assertBytes(value, fromBase64(authCommands[authAt++].base64));
            else if (stage === 1) {
              assertBytes(value, fromBase64(record.subscription.base64));
              stage++;
            } else if (stage === 2) {
              assertBytes(value, fromBase64(record.request.base64));
              stage++;
              controller.enqueue(fromBase64(record.replyWire.base64));
            } else assertBytes(value, fromBase64(replyCommands[replyAt++].base64));
          },
        }),
        close() {
          closes++;
          controller.close();
          if (stage !== 3 || authAt !== authCommands.length || replyAt !== replyCommands.length) {
            throw new Error("Packed NATS replay left commands incomplete");
          }
          return Promise.resolve();
        },
      };
      const client = new NatsClient({
        openChannel: () => Promise.resolve(channel),
        auth: { user: "opfs", password: "fixture-only-nats" },
      });
      const envelope = JSON.parse(new TextDecoder().decode(fromBase64(record.body.base64)));
      if (operation === "get") {
        const result = await client.get(natsNative.stream, natsNative.sequence, { inbox: natsNative.getInbox });
        assertBytes(result.bytes, oracle);
        if (
          result.sequence !== natsNative.sequence || result.subject !== "owned.data" ||
          result.time !== envelope.message.time
        ) throw new Error("Packed NATS native message identity changed");
      } else {
        const receipt = await client.publish(natsNative.stream, "owned.data", oracle, {
          inbox: natsNative.publishInbox,
          messageId: "independent-capture",
        });
        if (
          receipt.stream !== natsNative.stream || receipt.sequence !== String(envelope.seq) ||
          receipt.duplicate !== false
        ) throw new Error("Packed NATS publication receipt changed");
      }
      if (closes !== 1) throw new Error("Packed NATS did not close its exclusive channel once");
    }
  });
});
