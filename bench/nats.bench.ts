import { bench, do_not_optimize } from "mitata";
import { decodeBase64 } from "@std/encoding/base64";
import { NatsClient } from "../src/nats.ts";
import type { NatsChannelType } from "../src/nats.ts";
import { expectBytes, finish, report } from "./result.ts";
import fixture from "../tests/fixtures/nats/independent.json" with { type: "json" };

// Question: what does strict JetStream get-by-sequence admission add above the
// same fresh Webstreams handshake and a trusted fixed-offset JSON/base64 read?
// This is captured-fixture transport/parser cost, not server/TCP/TLS speed or
// equivalent validation. Both lanes acquire and close one channel per request.
interface CaptureType {
  readonly bytes: number;
  readonly base64: string;
  readonly sha256: string;
}
interface ControlType {
  readonly response: CaptureType;
  readonly command?: CaptureType;
}
interface TranscriptType {
  readonly initial: CaptureType;
  readonly pong: CaptureType;
  readonly response: CaptureType;
  readonly replyWire: CaptureType;
  readonly body: CaptureType;
  readonly subscription: CaptureType;
  readonly request: CaptureType;
  readonly authControls: readonly ControlType[];
  readonly controls: readonly ControlType[];
}
const get: TranscriptType = fixture.get;
const bytes = (record: { base64: string }): Uint8Array<ArrayBuffer> => new Uint8Array(decodeBase64(record.base64));
const initial = bytes(get.initial), pong = bytes(get.pong), reply = bytes(get.replyWire);
const subscription = bytes(get.subscription), request = bytes(get.request), body = bytes(get.body);
const oracle = bytes(fixture.oracle);
const encode = (text: string): Uint8Array<ArrayBuffer> => new TextEncoder().encode(text);
const connect = encode(
  'CONNECT {"verbose":false,"pedantic":true,"protocol":1,"headers":true,"no_responders":true,"lang":"typescript","version":"opfs-nats/1","user":"opfs","pass":"fixture-only-nats","tls_required":false}\r\nPING\r\n',
);
for (
  const record of [
    fixture.oracle,
    get.initial,
    get.pong,
    get.replyWire,
    get.response,
    get.body,
    get.subscription,
    get.request,
    ...get.authControls.flatMap((control) =>
      control.command !== undefined ? [control.response, control.command] : [control.response]
    ),
    ...get.controls.flatMap((control) =>
      control.command !== undefined ? [control.response, control.command] : [control.response]
    ),
  ]
) {
  const data = bytes(record);
  const hash = Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", data)),
    (value) => value.toString(16).padStart(2, "0"),
  ).join("");
  if (data.length !== record.bytes || hash !== record.sha256) throw new Error("Native NATS capture hash differs.");
}
const authFrames = get.authControls.map((control) => bytes(control.response));
const authCommands = get.authControls.flatMap((control) =>
  control.command !== undefined ? [bytes(control.command)] : []
);
const commands = get.controls.flatMap((control) => control.command !== undefined ? [bytes(control.command)] : []);
const bodyOffset = reply.length - body.length - 2;
expectBytes(reply.subarray(bodyOffset, bodyOffset + body.length), body, "nats/native-body-extent");

/** Replays untouched native control frames, without a server or a candidate parser. */
function channel(): NatsChannelType {
  let controller: ReadableStreamDefaultController<Uint8Array>, closed = false, stage = 0, authAt = 0, controlAt = 0;
  return {
    security: "plaintext",
    readable: new ReadableStream<Uint8Array>({
      start(value) {
        controller = value;
        controller.enqueue(initial);
      },
    }),
    writable: new WritableStream<Uint8Array>({
      write(value) {
        if (stage === 0) {
          expectBytes(value, connect, "nats/connect");
          stage++;
          for (const frame of authFrames) controller.enqueue(frame);
          controller.enqueue(pong);
        } else if (authAt < authCommands.length) expectBytes(value, authCommands[authAt++]!, "nats/auth-control");
        else if (stage === 1) {
          expectBytes(value, subscription, "nats/subscription");
          stage++;
        } else if (stage === 2) {
          expectBytes(value, request, "nats/get-request");
          stage++;
          controller.enqueue(reply);
        } else expectBytes(value, commands[controlAt++]!, "nats/reply-control");
      },
    }),
    close: () => {
      if (!closed) {
        closed = true;
        controller.close();
        if (stage !== 3 || authAt !== authCommands.length || controlAt !== commands.length) {
          return Promise.reject(new Error("Native NATS replay ended before all expected commands."));
        }
      }
      return Promise.resolve();
    },
  };
}
const client = new NatsClient({
  openChannel: () => Promise.resolve(channel()),
  auth: { user: "opfs", password: "fixture-only-nats" },
});
async function raw(): Promise<Uint8Array> {
  const peer = channel();
  const reader = peer.readable.getReader(), writer = peer.writable.getWriter();
  let primary: readonly unknown[] = [];
  try {
    await reader.read();
    await writer.write(connect);
    for (const control of get.authControls) {
      await reader.read();
      if (control.command !== undefined) await writer.write(bytes(control.command));
    }
    await reader.read();
    await writer.write(subscription);
    await writer.write(request);
    const next = await reader.read();
    if (next.done) throw new Error("Raw NATS fixture ended early.");
    for (const command of commands) await writer.write(command);
    const value = JSON.parse(new TextDecoder().decode(next.value.subarray(bodyOffset, bodyOffset + body.length)));
    return new Uint8Array(decodeBase64(value.message.data));
  } catch (reason) {
    primary = [reason];
    throw reason;
  } finally {
    await finish([() => {
      reader.releaseLock();
      writer.releaseLock();
    }, () => peer.close()], primary);
  }
}
expectBytes(
  (await client.get(fixture.stream, fixture.sequence, { inbox: fixture.getInbox })).bytes,
  oracle,
  "nats/client/nats-py-original",
);
expectBytes(await raw(), oracle, "nats/raw/nats-py-original");
bench(
  `nats raw Webstreams reply=${reply.length}B original=${oracle.length}B lower-bound validation=none fresh-channel`,
  async () => do_not_optimize(await raw()),
);
bench(
  `nats client GET reply=${reply.length}B original=${oracle.length}B validation=frames+uint64+base64+ownership fresh-channel`,
  async () => do_not_optimize(await client.get(fixture.stream, fixture.sequence, { inbox: fixture.getInbox })),
);
await report();
