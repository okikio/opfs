import { describe, it } from "node:test";
import { expect } from "@std/expect";
import { NatsClient, NatsCompletionError, NatsError, NatsPublicationError } from "../src/nats.ts";
import type { NatsChannelType, NatsOptionsType } from "../src/nats.ts";

const encode = (value: string): Uint8Array<ArrayBuffer> => new TextEncoder().encode(value);
const inbox = "_INBOX.owned.request";
const info = 'INFO {"max_payload":2097152,"headers":true}\r\n';
/** Authored native framing is independent of candidate packet and reply serialization. */
function message(body: string, subject = inbox, sid = "1"): Uint8Array<ArrayBuffer> {
  const payload = encode(body), prefix = encode(`MSG ${subject} ${sid} ${payload.length}\r\n`);
  const result = new Uint8Array(prefix.length + payload.length + 2);
  result.set(prefix);
  result.set(payload, prefix.length);
  result.set([13, 10], result.length - 2);
  return result;
}
function peer(reply: Uint8Array | (() => Uint8Array | undefined), options: {
  info?: string;
  fragment?: boolean;
  closeError?: unknown;
  writeError?: unknown;
  afterWrite?: (index: number) => void;
} = {}) {
  let controller: ReadableStreamDefaultController<Uint8Array>, ended = false, closes = 0;
  const writes: Uint8Array[] = [];
  function send(bytes: Uint8Array): void {
    if (options.fragment) { for (const byte of bytes) controller.enqueue(new Uint8Array([byte])); }
    else controller.enqueue(bytes);
  }
  const channel: NatsChannelType = {
    security: "plaintext",
    readable: new ReadableStream<Uint8Array>({
      start(value) {
        controller = value;
        send(encode(options.info ?? info));
      },
    }),
    writable: new WritableStream<Uint8Array>({
      write(bytes) {
        writes.push(new Uint8Array(bytes));
        const line = new TextDecoder().decode(bytes);
        if (line.startsWith("CONNECT ")) send(encode("PONG\r\n"));
        if (line.startsWith("PUB ") || line.startsWith("HPUB ")) {
          if (options.writeError !== undefined) throw options.writeError;
          const output = typeof reply === "function" ? reply() : reply;
          if (output) send(output);
        }
        options.afterWrite?.(writes.length - 1);
      },
    }),
    close: () => {
      closes++;
      if (!ended) {
        ended = true;
        controller.close();
      }
      return options.closeError === undefined ? Promise.resolve() : Promise.reject(options.closeError);
    },
  };
  const config: NatsOptionsType = { openChannel: async () => channel };
  return { channel, config, writes, send, closes: () => closes };
}
const stored =
  '{"type":"io.nats.jetstream.api.v1.stream_msg_get_response","message":{"subject":"orders.new","seq":18446744073709551615,"time":"2026-11-05T15:00:00.123456789Z","data":"AP8NCg==","hdrs":"TkFUUy8xLjANCg0K"}}';
const ack = '{"stream":"ORDERS","seq":18446744073709551615,"duplicate":true}';

describe("bounded NATS JetStream request/reply", () => {
  it("retrieves complete binary payload and inert headers with exact uint64 sequence and timestamp", async () => {
    const wire = peer(message(stored), { fragment: true });
    const result = await new NatsClient(wire.config).get("ORDERS", "18446744073709551615", { inbox });
    expect(result).toEqual({
      stream: "ORDERS",
      sequence: "18446744073709551615",
      subject: "orders.new",
      time: "2026-11-05T15:00:00.123456789Z",
      bytes: new Uint8Array([0, 255, 13, 10]),
      headers: encode("NATS/1.0\r\n\r\n"),
    });
    expect(wire.writes.map((v) => new TextDecoder().decode(v))).toEqual([
      'CONNECT {"verbose":false,"pedantic":true,"protocol":1,"headers":true,"no_responders":true,"lang":"typescript","version":"opfs-nats/1","tls_required":false}\r\nPING\r\n',
      `SUB ${inbox} 1\r\nUNSUB 1 1\r\n`,
      `PUB $JS.API.STREAM.MSG.GET.ORDERS ${inbox} 28\r\n{"seq":18446744073709551615}\r\n`,
    ]);
    expect(wire.closes()).toBe(1);
  });
  it("publishes binary bytes with expected-stream admission and native dedup receipt", async () => {
    const wire = peer(message(ack));
    const result = await new NatsClient(wire.config).publish("ORDERS", "orders.new", new Uint8Array([0, 255, 13, 10]), {
      inbox,
      messageId: "owned-id",
    });
    expect(result).toEqual({ stream: "ORDERS", sequence: "18446744073709551615", duplicate: true });
    const request = wire.writes[2]!;
    expect(new TextDecoder().decode(request)).toContain(
      "Nats-Expected-Stream: ORDERS\r\nNats-Msg-Id: owned-id\r\n\r\n",
    );
    expect(Array.from(request.slice(-6))).toEqual([0, 255, 13, 10, 13, 10]);
    expect(wire.closes()).toBe(1);
  });
  it("captures credentials, byte views, options and acquire method before awaited callbacks", async () => {
    const wire = peer(message(ack)), bytes = new Uint8Array([1, 2]), auth = { token: "original" };
    let calls = 0;
    const options = {
      inbox,
      get messageId() {
        calls++;
        bytes.fill(9);
        return "id";
      },
    };
    const config: NatsOptionsType = {
      auth,
      openChannel: async () => {
        auth.token = "changed";
        return wire.channel;
      },
    };
    const client = new NatsClient(config);
    const pending = client.publish("ORDERS", "orders.new", bytes, options);
    const result = await pending;
    expect(result.duplicate).toBe(true);
    expect(calls).toBe(1);
    expect(new TextDecoder().decode(wire.writes[0])).toContain('"auth_token":"original"');
    expect(Array.from(wire.writes[2]!.slice(-4))).toEqual([1, 2, 13, 10]);
  });
  it("dispatches no later writes after cancellation at INFO, PONG or SUB boundaries", async () => {
    for (const phase of ["info", "pong", "sub"] as const) {
      const abort = new AbortController(), reason = new Error(`abort at ${phase}`);
      const wire = peer(message(ack), {
        afterWrite: (index) => {
          if (phase === "sub" && index === 1) abort.abort(reason);
        },
      });
      const reader = wire.channel.readable.getReader();
      let reads = 0;
      const intercepted = {
        async read() {
          const result = await reader.read();
          reads++;
          if (result.done) return result;
          return {
            done: false as const,
            get value() {
              if (phase === "info" && reads === 1 || phase === "pong" && reads === 2) abort.abort(reason);
              return result.value;
            },
          };
        },
        releaseLock: () => reader.releaseLock(),
      };
      const channel: NatsChannelType = {
        ...wire.channel,
        readable: { getReader: () => intercepted } as unknown as ReadableStream<Uint8Array>,
      };
      await expect(
        new NatsClient({ openChannel: async () => channel }).publish("ORDERS", "orders.new", new Uint8Array(), {
          inbox,
          signal: abort.signal,
        }),
      ).rejects.toBe(reason);
      expect(wire.writes).toHaveLength(phase === "info" ? 0 : phase === "pong" ? 1 : 2);
      expect(wire.closes()).toBe(1);
      expect(wire.channel.readable.locked).toBe(false);
    }
  });
  it("rejects invalid subjects, sequences, inbox aliases and pre-abort without acquisition", async () => {
    let count = 0;
    const client = new NatsClient({
      openChannel: async () => {
        count++;
        throw new Error("unexpected");
      },
    });
    for (const seq of ["0", "01", "18446744073709551616", "1e3", "1.0"]) {
      expect(() => client.get("ORDERS", seq, { inbox })).toThrow();
    }
    expect(() => client.get("ORDERS.bad", "1", { inbox })).toThrow();
    expect(() => client.publish("ORDERS", "orders.*", new Uint8Array(), { inbox })).toThrow();
    await expect(client.publish("ORDERS", inbox, new Uint8Array(), { inbox })).rejects.toThrow("differ");
    const abort = new AbortController(), reason = new Error("already stopped");
    abort.abort(reason);
    await expect(client.get("ORDERS", "1", { inbox, signal: abort.signal })).rejects.toBe(reason);
    expect(count).toBe(0);
  });
  it("requires an explicit secure adapter before sending credentials to TLS-required endpoints", async () => {
    const wire = peer(message(ack), { info: 'INFO {"headers":true,"max_payload":1024,"tls_required":true}\r\n' });
    await expect(
      new NatsClient({ ...wire.config, auth: { token: "secret" } }).publish("ORDERS", "orders.new", new Uint8Array(), {
        inbox,
      }),
    ).rejects.toBeInstanceOf(NatsError);
    expect(wire.writes).toEqual([]);
    expect(wire.closes()).toBe(1);
  });
  it("bounds native max_payload before publication dispatch", async () => {
    const wire = peer(message(ack), { info: 'INFO {"headers":true,"max_payload":1}\r\n' });
    await expect(new NatsClient(wire.config).publish("ORDERS", "orders.new", new Uint8Array(), { inbox })).rejects
      .toThrow("max_payload");
    expect(wire.writes).toHaveLength(1);
  });
  it("services bounded PING and INFO without endpoint discovery", async () => {
    const original = message(ack),
      prelude = encode('PING\r\nINFO {"headers":true,"max_payload":1024,"connect_urls":["attacker:4222"]}\r\n');
    const reply = new Uint8Array(prelude.length + original.length);
    reply.set(prelude);
    reply.set(original, prelude.length);
    const wire = peer(reply);
    await new NatsClient(wire.config).publish("ORDERS", "orders.new", new Uint8Array(), { inbox });
    expect(new TextDecoder().decode(wire.writes[3])).toBe("PONG\r\n");
  });
  it("keeps attributed refusal plus independent cleanup instead of labeling it unknown", async () => {
    const cleanup = new Error("close failed"),
      wire = peer(message('{"error":{"code":400,"err_code":10060}}'), { closeError: cleanup });
    try {
      await new NatsClient(wire.config).publish("ORDERS", "orders.new", new Uint8Array(), { inbox });
      throw new Error("expected refusal");
    } catch (reason) {
      expect(reason).toBeInstanceOf(AggregateError);
      const errors = (reason as AggregateError).errors;
      expect(errors[0]).toBeInstanceOf(NatsError);
      expect(errors[1]).toBe(cleanup);
    }
  });
  it("preserves a complete native acknowledgement when closing fails", async () => {
    const cleanup = new Error("close failed"), wire = peer(message(ack), { closeError: cleanup });
    try {
      await new NatsClient(wire.config).publish("ORDERS", "orders.new", new Uint8Array(), { inbox });
      throw new Error("expected cleanup failure");
    } catch (reason) {
      expect(reason).toBeInstanceOf(NatsCompletionError);
      expect((reason as NatsCompletionError).receipt).toEqual({
        stream: "ORDERS",
        sequence: "18446744073709551615",
        duplicate: true,
      });
      expect((reason as Error).cause).toBe(cleanup);
    }
  });
  it("marks lost writes and unrelated protocol errors as unknown publications without retry", async () => {
    for (const variant of [{ writeError: new Error("write lost") }, {}]) {
      const wire = peer(encode("-ERR 'Permissions Violation for Subscription'\r\n"), variant);
      await expect(new NatsClient(wire.config).publish("ORDERS", "orders.new", new Uint8Array(), { inbox })).rejects
        .toBeInstanceOf(NatsPublicationError);
      expect(wire.writes).toHaveLength(3);
      expect(wire.closes()).toBe(1);
    }
  });
  it("admits exact native no-responders status as refusal without disclosing server prose", async () => {
    const h = "NATS/1.0 503 No Responders\r\n\r\n",
      wire = peer(encode(`HMSG ${inbox} 1 ${h.length} ${h.length}\r\n${h}\r\n`));
    try {
      await new NatsClient(wire.config).publish("ORDERS", "orders.new", new Uint8Array(), { inbox });
      throw new Error("expected refusal");
    } catch (reason) {
      expect(reason).toBeInstanceOf(NatsError);
      expect((reason as NatsError).code).toBe("503");
    }
  });
  it("rejects lossy JSON numeric lexemes, duplicate authority, unrelated stream and noncanonical base64", async () => {
    for (
      const body of [
        ack.replace("18446744073709551615", "1.1"),
        ack.replace("18446744073709551615", "1e0"),
        ack.replace('"ORDERS"', '"OTHER"'),
        ack.replace('"seq":', '"seq":1,"seq":'),
        ack.slice(0, -1) + ',"error":{"code":400}}',
      ]
    ) {
      const wire = peer(message(body));
      await expect(new NatsClient(wire.config).publish("ORDERS", "orders.new", new Uint8Array(), { inbox })).rejects
        .toBeInstanceOf(NatsPublicationError);
    }
    const wire = peer(message(stored.replace("AP8NCg==", "AP8NCh==")));
    await expect(new NatsClient(wire.config).get("ORDERS", "18446744073709551615", { inbox })).rejects.toThrow();
  });
  it("refuses unrelated inbox/SID, oversized frames and malformed CRLF with owned cleanup", async () => {
    for (
      const response of [
        message(stored, "_INBOX.other"),
        message(stored, inbox, "2"),
        encode(`MSG ${inbox} 1 2097153\r\n`),
        encode("PING\n"),
      ]
    ) {
      const wire = peer(response);
      await expect(new NatsClient(wire.config).get("ORDERS", "1", { inbox })).rejects.toThrow();
      expect(wire.closes()).toBe(1);
      expect(wire.channel.readable.locked).toBe(false);
      expect(wire.channel.writable.locked).toBe(false);
    }
  });
  it("bounds stalled bodies and control floods, and retains partial stream-lock cleanup", async () => {
    const stalled = peer(() => undefined);
    // The in-memory transport owns no socket handle. Keep this test alive while
    // Node's unreferenced AbortSignal timeout exercises the real client deadline.
    const alive = setTimeout(() => {}, 1000);
    try {
      await expect(new NatsClient({ ...stalled.config, timeoutMs: 10 }).get("ORDERS", "1", { inbox })).rejects
        .toThrow();
    } finally {
      clearTimeout(alive);
    }
    expect(stalled.closes()).toBe(1);
    const flood = peer(encode("PING\r\n".repeat(129)));
    await expect(new NatsClient(flood.config).get("ORDERS", "1", { inbox })).rejects.toThrow("control budget");
    const locked = peer(message(ack)), reader = locked.channel.readable.getReader();
    await expect(new NatsClient(locked.config).get("ORDERS", "1", { inbox })).rejects.toThrow();
    expect(locked.closes()).toBe(1);
    reader.releaseLock();
  });
});

describe("independent native NATS transcript", () => {
  it("replays unchanged native controls, sequence-get and publish acknowledgements with all SDK-original bytes", async () => {
    const { default: fixture } = await import("./fixtures/nats/independent.json", { with: { type: "json" } });
    const { decodeBase64 } = await import("@std/encoding/base64");
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
    const bytes = (value: CaptureType): Uint8Array<ArrayBuffer> => new Uint8Array(decodeBase64(value.base64));
    const oracle = bytes(fixture.oracle);
    for (const operation of ["get", "publish"] as const) {
      const record: TranscriptType = fixture[operation];
      const controls = [...record.authControls, ...record.controls];
      for (
        const entry of [
          fixture.oracle,
          record.initial,
          record.pong,
          record.response,
          record.replyWire,
          record.body,
          record.subscription,
          record.request,
          ...controls.flatMap((control) =>
            control.command === undefined ? [control.response] : [control.response, control.command]
          ),
        ]
      ) {
        const value = bytes(entry);
        expect(value.length).toBe(entry.bytes);
        const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", value));
        expect(Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("")).toBe(entry.sha256);
      }
      let controller: ReadableStreamDefaultController<Uint8Array>, stage = 0, authAt = 0, replyAt = 0, closes = 0;
      const authCommands = record.authControls.flatMap((control) =>
        control.command === undefined ? [] : [control.command]
      );
      const replyCommands = record.controls.flatMap((control) =>
        control.command === undefined ? [] : [control.command]
      );
      const channel: NatsChannelType = {
        security: "plaintext",
        readable: new ReadableStream<Uint8Array>({
          start(value) {
            controller = value;
            controller.enqueue(bytes(record.initial));
          },
        }),
        writable: new WritableStream<Uint8Array>({
          write(value) {
            if (stage === 0) {
              expect(value).toEqual(
                encode(
                  'CONNECT {"verbose":false,"pedantic":true,"protocol":1,"headers":true,"no_responders":true,"lang":"typescript","version":"opfs-nats/1","user":"opfs","pass":"fixture-only-nats","tls_required":false}\r\nPING\r\n',
                ),
              );
              stage++;
              for (const control of record.authControls) controller.enqueue(bytes(control.response));
              controller.enqueue(bytes(record.pong));
            } else if (authAt < authCommands.length) expect(value).toEqual(bytes(authCommands[authAt++]!));
            else if (stage === 1) {
              expect(value).toEqual(bytes(record.subscription));
              stage++;
            } else if (stage === 2) {
              expect(value).toEqual(bytes(record.request));
              stage++;
              controller.enqueue(bytes(record.replyWire));
            } else expect(value).toEqual(bytes(replyCommands[replyAt++]!));
          },
        }),
        close: () => {
          closes++;
          controller.close();
          if (stage !== 3 || authAt !== authCommands.length || replyAt !== replyCommands.length) {
            return Promise.reject(new Error("Native NATS replay ended before all expected commands."));
          }
          return Promise.resolve();
        },
      };
      const client = new NatsClient({
        openChannel: () => Promise.resolve(channel),
        auth: { user: "opfs", password: "fixture-only-nats" },
      });
      const envelope = JSON.parse(new TextDecoder().decode(bytes(record.body)));
      if (operation === "get") {
        const result = await client.get(fixture.stream, fixture.sequence, { inbox: fixture.getInbox });
        expect(result.bytes).toEqual(oracle);
        expect(result.sequence).toBe(fixture.sequence);
        expect(result.time).toBe(envelope.message.time);
        expect(result.subject).toBe("owned.data");
      } else {
        const result = await client.publish(fixture.stream, "owned.data", oracle, {
          inbox: fixture.publishInbox,
          messageId: "independent-capture",
        });
        expect(result).toEqual({ stream: fixture.stream, sequence: String(envelope.seq), duplicate: false });
      }
      expect(stage).toBe(3);
      expect(authAt).toBe(authCommands.length);
      expect(replyAt).toBe(replyCommands.length);
      expect(closes).toBe(1);
    }
  });
});
