import { describe, it } from "node:test";
import { expect } from "@std/expect";
import { AmqpClient, AmqpCompletionError, AmqpError, AmqpOutcomeError } from "../src/amqp.ts";
import type { AmqpChannelType, AmqpOptionsType } from "../src/amqp.ts";

/** Authored peer encoder, separate from candidate frame/property code. Native qualification is a separate fixture. */
const utf = (value: string): Uint8Array<ArrayBuffer> => new TextEncoder().encode(value);
function cat(...parts: readonly Uint8Array[]): Uint8Array<ArrayBuffer> {
  const output = new Uint8Array(parts.reduce((n, part) => n + part.length, 0));
  let at = 0;
  for (const part of parts) {
    output.set(part, at);
    at += part.length;
  }
  return output;
}
function uint(value: number | bigint, size: 1 | 2 | 4 | 8): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(size);
  let rest = BigInt(value);
  for (let index = size - 1; index >= 0; index--) {
    out[index] = Number(rest & 255n);
    rest >>= 8n;
  }
  return out;
}
const str = (value: string): Uint8Array<ArrayBuffer> => cat(uint(utf(value).length, 1), utf(value));
const raw = (bytes: Uint8Array): Uint8Array<ArrayBuffer> => cat(uint(bytes.length, 4), bytes);
const packet = (type: number, channel: number, body: Uint8Array): Uint8Array<ArrayBuffer> =>
  cat(uint(type, 1), uint(channel, 2), uint(body.length, 4), body, uint(206, 1));
const method = (channel: number, cls: number, id: number, ...parts: readonly Uint8Array[]): Uint8Array<ArrayBuffer> =>
  packet(1, channel, cat(uint(cls, 2), uint(id, 2), ...parts));
const ack = (tag = 1n, bits = 0): Uint8Array<ArrayBuffer> => method(1, 60, 80, uint(tag, 8), uint(bits, 1));
function content(bytes: Uint8Array, properties = uint(0, 2), declared = BigInt(bytes.length)): Uint8Array<ArrayBuffer> {
  return cat(
    packet(2, 1, cat(uint(60, 2), uint(0, 2), uint(declared, 8), properties)),
    ...(bytes.length ? [packet(3, 1, bytes)] : []),
  );
}
function delivery(
  bytes: Uint8Array,
  properties = uint(0, 2),
  declared = BigInt(bytes.length),
): Uint8Array<ArrayBuffer> {
  return cat(
    method(1, 60, 71, uint(18446744073709551615n, 8), uint(1, 1), str("owned"), str("key"), uint(7, 4)),
    content(bytes, properties, declared),
  );
}
interface PeerType {
  fragment?: boolean;
  reply?: Uint8Array | (() => Uint8Array | undefined);
  closeError?: unknown;
  gracefulError?: boolean;
  security?: "plaintext" | "tls";
  heartbeat?: number;
  frameMax?: number;
  mechanisms?: string;
  authRefusal?: boolean;
  afterWrite?: (bytes: Uint8Array, count: number) => void;
  failPublish?: unknown;
}
function peer(options: PeerType = {}) {
  let controller: ReadableStreamDefaultController<Uint8Array>, closed = false, closes = 0, expected = -1, received = 0;
  const writes: Uint8Array<ArrayBuffer>[] = [];
  function send(bytes: Uint8Array): void {
    if (options.fragment) { for (const byte of bytes) controller.enqueue(new Uint8Array([byte])); }
    else controller.enqueue(new Uint8Array(bytes));
  }
  function reply(): void {
    const value = typeof options.reply === "function" ? options.reply() : options.reply;
    if (value) send(value);
  }
  const channel: AmqpChannelType = {
    security: options.security ?? "plaintext",
    readable: new ReadableStream<Uint8Array>({
      start(value) {
        controller = value;
        send(
          method(
            0,
            10,
            10,
            uint(0, 1),
            uint(9, 1),
            uint(0, 4),
            raw(utf(options.mechanisms ?? "PLAIN")),
            raw(utf("en_US")),
          ),
        );
      },
    }),
    writable: new WritableStream<Uint8Array>({
      write(bytes) {
        const copy = new Uint8Array(bytes);
        writes.push(copy);
        if (bytes[0] !== 65) {
          const type = bytes[0], cls = bytes[7]! * 256 + bytes[8]!, id = bytes[9]! * 256 + bytes[10]!;
          if (type === 1 && cls === 10 && id === 11) {
            send(
              options.authRefusal
                ? method(0, 10, 50, uint(403, 2), str("private credential refusal"), uint(10, 2), uint(11, 2))
                : method(0, 10, 30, uint(1, 2), uint(options.frameMax ?? 65536, 4), uint(options.heartbeat ?? 60, 2)),
            );
          }
          if (type === 1 && cls === 10 && id === 40) send(method(0, 10, 41, str("")));
          if (type === 1 && cls === 20 && id === 10) send(method(1, 20, 11, raw(new Uint8Array())));
          if (type === 1 && cls === 85 && id === 10) send(method(1, 85, 11));
          if (type === 1 && cls === 60 && id === 40 && options.failPublish !== undefined) throw options.failPublish;
          if (type === 1 && cls === 60 && id === 70) reply();
          if (type === 2) {
            expected = Number(new DataView(copy.buffer).getBigUint64(11));
            received = 0;
            if (!expected) reply();
          }
          if (type === 3) {
            received += bytes.length - 8;
            if (received === expected) reply();
          }
          if (type === 1 && cls === 10 && id === 50) {
            send(options.gracefulError ? method(1, 60, 80, uint(99n, 8), uint(0, 1)) : method(0, 10, 51));
          }
        }
        options.afterWrite?.(copy, writes.length);
      },
    }),
    async close() {
      closes++;
      if (!closed) {
        closed = true;
        controller.close();
      }
      if (options.closeError !== undefined) throw options.closeError;
    },
  };
  const config: AmqpOptionsType = {
    openChannel: async () => channel,
    auth: { user: "fixture", password: "fixture-only" },
    vhost: "/owned",
    allowPlaintext: true,
  };
  return { channel, config, send, writes, closes: () => closes };
}
function bodyWrites(writes: readonly Uint8Array[]): Uint8Array<ArrayBuffer> {
  return cat(...writes.filter((bytes) => bytes[0] === 3).map((bytes) => bytes.subarray(7, -1)));
}
async function failure(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (reason) {
    return reason;
  }
  throw new Error("Expected operation failure.");
}

describe("bounded AMQP 0-9-1 native client", () => {
  it("takes fragmented binary data with lossless delivery tag and explicit auto-ack", async () => {
    const bytes = new Uint8Array([0, 255, 13, 10]), wire = peer({ reply: delivery(bytes), fragment: true });
    const message = await new AmqpClient(wire.config).take("owned", { autoAck: true });
    expect(message).toEqual({
      bytes,
      properties: uint(0, 2),
      deliveryTag: "18446744073709551615",
      redelivered: true,
      exchange: "owned",
      routingKey: "key",
      remaining: 7,
    });
    expect(wire.closes()).toBe(1);
    const request = wire.writes.find((bytes) => bytes[0] === 1 && bytes[9] === 0 && bytes[10] === 70)!;
    expect(request.at(-2)).toBe(1);
  });
  it("returns point-in-time empty separately from a zero-byte message", async () => {
    const empty = peer({ reply: method(1, 60, 72, str("")) });
    expect(await new AmqpClient(empty.config).take("owned", { autoAck: true })).toBeNull();
    const zero = peer({ reply: delivery(new Uint8Array()) });
    expect((await new AmqpClient(zero.config).take("owned", { autoAck: true }))?.bytes.length).toBe(0);
  });
  it("splits publication at negotiated frame size and preserves native ack", async () => {
    const bytes = new Uint8Array(9000).map((_, at) => at % 256), wire = peer({ reply: ack(), frameMax: 4096 });
    expect(await new AmqpClient(wire.config).publish("owned", "key", bytes)).toEqual({
      confirmation: "ack",
      requeue: false,
    });
    expect(bodyWrites(wire.writes)).toEqual(bytes);
    expect(wire.writes.filter((part) => part[0] === 3).map((part) => part.length)).toEqual([4096, 4096, 832]);
  });
  it("retains mandatory return before ack and does not equate ack with routing", async () => {
    const bytes = new Uint8Array([0, 255]);
    const wire = peer({
      reply: cat(
        method(1, 60, 50, uint(312, 2), str("private reason"), str("owned"), str("key")),
        content(bytes),
        ack(0n, 1),
      ),
    });
    expect(await new AmqpClient(wire.config).publish("owned", "key", bytes)).toEqual({
      confirmation: "ack",
      requeue: false,
      returned: { code: 312, exchange: "owned", routingKey: "key", bytes, properties: uint(0, 2) },
    });
  });
  it("retains a complete mandatory return if the later confirmation is invalid", async () => {
    const bytes = new Uint8Array([0, 255]);
    const wire = peer({
      reply: cat(method(1, 60, 50, uint(312, 2), str("unroutable"), str("owned"), str("key")), content(bytes), ack(2n)),
    });
    const reason = await failure(new AmqpClient(wire.config).publish("owned", "key", bytes));
    expect(reason).toBeInstanceOf(AmqpOutcomeError);
    expect((reason as AmqpOutcomeError).returned).toEqual({
      code: 312,
      exchange: "owned",
      routingKey: "key",
      bytes,
      properties: uint(0, 2),
    });
  });
  it("retains nack as native partial-effect evidence", async () => {
    const wire = peer({ reply: method(1, 60, 120, uint(1, 8), uint(2, 1)) });
    expect(await new AmqpClient(wire.config).publish("", "owned", new Uint8Array())).toEqual({
      confirmation: "nack",
      requeue: true,
    });
  });
  it("validates all Basic property positions including timestamp and nested field values", async () => {
    const items = raw(cat(utf("T"), uint(18446744073709551615n, 8), utf("x"), raw(new Uint8Array([0, 255]))));
    const table = raw(cat(str("nested"), utf("F"), raw(cat(str("items"), utf("A"), items))));
    const props = cat(
      uint(65532, 2),
      str("application/octet-stream"),
      str("identity"),
      table,
      uint(2, 1),
      uint(255, 1),
      str("correlation"),
      str("reply"),
      str("1000"),
      str("id"),
      uint(18446744073709551615n, 8),
      str("kind"),
      str("user"),
      str("app"),
      str("cluster"),
    );
    const wire = peer({ reply: delivery(new Uint8Array([1]), props) });
    expect((await new AmqpClient(wire.config).take("owned", { autoAck: true }))?.properties).toEqual(props);
  });
  it("refuses malformed field grammar, duplicate names, flag continuation and truncated property values", async () => {
    const bad = [
      uint(1, 2),
      uint(2, 2),
      cat(uint(32768, 2), uint(3, 1), utf("a")),
      cat(uint(8192, 2), raw(cat(str("x"), utf("?")))),
      cat(uint(8192, 2), raw(cat(str("x"), utf("V"), str("x"), utf("V")))),
      cat(uint(8192, 2), raw(cat(str("x"), utf("t"), uint(2, 1)))),
      cat(uint(8192, 2), raw(cat(str("x"), utf("A"), raw(cat(utf("I"), uint(1, 1)))))),
    ];
    for (const props of bad) {
      const wire = peer({ reply: delivery(new Uint8Array(), props) });
      const reason = await failure(new AmqpClient(wire.config).take("owned", { autoAck: true }));
      expect(reason).toBeInstanceOf(AmqpOutcomeError);
      expect(wire.closes()).toBe(1);
    }
  });
  it("admits uint64 body length before allocation and refuses wrong terminal sequence", async () => {
    const huge = peer({ reply: delivery(new Uint8Array(), uint(0, 2), 18446744073709551615n) });
    const reason = await failure(new AmqpClient(huge.config).take("owned", { autoAck: true }));
    expect(reason).toBeInstanceOf(AmqpOutcomeError);
    expect((reason as Error).cause).toBeInstanceOf(RangeError);
    const wrong = peer({ reply: ack(2n) });
    expect(await failure(new AmqpClient(wrong.config).publish("owned", "key", new Uint8Array()))).toBeInstanceOf(
      AmqpOutcomeError,
    );
  });
  it("refuses unsafe text/permission/oversized body before transport acquisition", () => {
    let acquired = 0;
    const client = new AmqpClient({
      openChannel: () => {
        acquired++;
        throw new Error("unreachable");
      },
      auth: { user: "u", password: "p" },
      vhost: "/owned",
    });
    expect(() => client.take("owned", { autoAck: false as true })).toThrow(TypeError);
    expect(() => client.publish("bad\r\n", "key", new Uint8Array())).toThrow(TypeError);
    expect(() => client.publish("owned", "\ud800", new Uint8Array())).toThrow(TypeError);
    expect(() => client.publish("owned", "key", new Uint8Array(1048577))).toThrow(RangeError);
    expect(acquired).toBe(0);
  });
  it("requires explicit plaintext grant before sending protocol or credentials", async () => {
    const wire = peer();
    expect(await failure(new AmqpClient({ ...wire.config, allowPlaintext: false }).take("owned", { autoAck: true })))
      .toBeInstanceOf(TypeError);
    expect(wire.writes.length).toBe(0);
    expect(wire.closes()).toBe(1);
  });
  it("snapshots credential and publication bytes before asynchronous acquisition", async () => {
    const bytes = new Uint8Array([0, 255]), expected = bytes.slice(), wire = peer({ reply: ack() });
    const auth = { user: "u", password: "p" };
    const client = new AmqpClient({
      ...wire.config,
      auth,
      openChannel: async () => {
        bytes.fill(9);
        auth.password = "changed";
        return wire.channel;
      },
    });
    await client.publish("owned", "key", bytes);
    expect(bodyWrites(wire.writes)).toEqual(expected);
    const start = wire.writes[1]!;
    expect(new TextDecoder().decode(start)).toContain("\u0000u\u0000p");
    expect(new TextDecoder().decode(start)).not.toContain("changed");
  });
  it("copies publication bytes before a foreign signal getter can mutate them", async () => {
    const bytes = new Uint8Array([0, 255]),
      original = bytes.slice(),
      wire = peer({ reply: ack() }),
      controller = new AbortController();
    let reads = 0;
    await new AmqpClient(wire.config).publish("owned", "key", bytes, {
      get signal(): AbortSignal {
        reads++;
        bytes.fill(7);
        return controller.signal;
      },
    });
    expect(reads).toBe(1);
    expect(bodyWrites(wire.writes)).toEqual(original);
  });
  it("preserves leading UTF-8 BOM in native routing declarations and inert properties", async () => {
    const bomKey = "\ufeffkey", property = cat(uint(32768, 2), str("\ufefftype"));
    const response = cat(
      method(1, 60, 71, uint(1, 8), uint(0, 1), str("\ufeffowned"), str(bomKey), uint(0, 4)),
      content(new Uint8Array(), property),
    );
    const wire = peer({ reply: response });
    const message = await new AmqpClient(wire.config).take("owned", { autoAck: true });
    expect(message?.exchange).toBe("\ufeffowned");
    expect(message?.routingKey).toBe(bomKey);
    expect(message?.properties).toEqual(property);
    const returned = peer({
      reply: cat(
        method(1, 60, 50, uint(312, 2), str("returned"), str("owned"), str(bomKey)),
        content(new Uint8Array()),
        ack(),
      ),
    });
    const reason = await failure(new AmqpClient(returned.config).publish("owned", "key", new Uint8Array()));
    expect(reason).toBeInstanceOf(AmqpOutcomeError);
    expect((reason as AmqpOutcomeError).returned).toBeUndefined();
  });
  it("keeps distinct BOM-prefixed field-table keys instead of silently aliasing them", async () => {
    const table = raw(cat(str("key"), utf("V"), str("\ufeffkey"), utf("V")));
    const props = cat(uint(8192, 2), table), wire = peer({ reply: delivery(new Uint8Array(), props) });
    expect((await new AmqpClient(wire.config).take("owned", { autoAck: true }))?.properties).toEqual(props);
  });
  it("does not send another method after cancellation between handshake writes", async () => {
    const controller = new AbortController(),
      reason = new Error("cancel"),
      wire = peer({
        afterWrite(_bytes, count) {
          if (count === 2) controller.abort(reason);
        },
      });
    expect(await failure(new AmqpClient(wire.config).take("owned", { autoAck: true, signal: controller.signal }))).toBe(
      reason,
    );
    expect(wire.writes.length).toBe(2);
    expect(wire.closes()).toBe(1);
  });
  it("classifies partial publication transport failure as unknown and preserves cleanup failure", async () => {
    const primary = new Error("write"),
      cleanup = new Error("retire"),
      wire = peer({ failPublish: primary, closeError: cleanup });
    const reason = await failure(new AmqpClient(wire.config).publish("owned", "key", new Uint8Array([1])));
    expect(reason).toBeInstanceOf(AggregateError);
    const errors = (reason as AggregateError).errors;
    expect(errors[0]).toBeInstanceOf(AmqpOutcomeError);
    expect(errors[0].cause).toBe(primary);
    expect(errors[1]).toBe(cleanup);
  });
  it("retains complete empty or confirmed results if graceful or physical close fails", async () => {
    const cleanup = new Error("retire"), empty = peer({ reply: method(1, 60, 72, str("")), closeError: cleanup });
    const reason = await failure(new AmqpClient(empty.config).take("owned", { autoAck: true }));
    expect(reason).toBeInstanceOf(AmqpCompletionError);
    expect((reason as AmqpCompletionError).receipt).toBeNull();
    expect((reason as Error).cause).toBe(cleanup);
    const duplicate = peer({ reply: ack(), gracefulError: true });
    const confirmed = await failure(new AmqpClient(duplicate.config).publish("owned", "key", new Uint8Array()));
    expect(confirmed).toBeInstanceOf(AmqpCompletionError);
    expect((confirmed as AmqpCompletionError).receipt).toEqual({ confirmation: "ack", requeue: false });
  });
  it("advertises supported auth-failure notifications and retains a pre-dispatch refusal", async () => {
    const wire = peer({ authRefusal: true });
    const reason = await failure(new AmqpClient(wire.config).take("owned", { autoAck: true }));
    expect(reason).toBeInstanceOf(AmqpError);
    expect((reason as AmqpError).code).toBe(403);
    expect(String(reason)).not.toContain("private credential");
    const advertised = raw(
      cat(str("capabilities"), utf("F"), raw(cat(str("authentication_failure_close"), utf("t"), uint(1, 1)))),
    );
    expect(wire.writes[1]!.subarray(11, 11 + advertised.length)).toEqual(advertised);
    expect(wire.writes.length).toBe(2);
    expect(wire.closes()).toBe(1);
  });
  it("sanitizes native refusal and refuses unsupported authentication mechanisms before credentials", async () => {
    const refused = method(1, 20, 40, uint(404, 2), str("private queue name"), uint(60, 2), uint(70, 2));
    const wire = peer({ reply: refused });
    const reason = await failure(new AmqpClient(wire.config).take("owned", { autoAck: true }));
    expect(reason).toBeInstanceOf(AmqpOutcomeError);
    expect((reason as Error).cause).toBeInstanceOf(AmqpError);
    expect(String((reason as Error).cause)).not.toContain("private queue");
    const unsupported = peer({ mechanisms: "EXTERNAL" });
    expect(await failure(new AmqpClient(unsupported.config).take("owned", { autoAck: true }))).toBeInstanceOf(
      TypeError,
    );
    expect(unsupported.writes.length).toBe(1);
  });
  it("rejects concurrent operations without queuing or acquiring a second transport", async () => {
    const controller = new AbortController(), wire = peer(), client = new AmqpClient(wire.config);
    const pending = client.take("owned", { autoAck: true, signal: controller.signal });
    expect(await failure(client.take("owned", { autoAck: true }))).toBeInstanceOf(TypeError);
    controller.abort();
    await failure(pending);
    expect(wire.closes()).toBe(1);
  });
  it("services heartbeats through the same writer while retaining one pending read", async () => {
    const bytes = new Uint8Array([1, 2]);
    const wire = peer({
      heartbeat: 1,
      afterWrite(packet) {
        if (packet[0] === 8) wire.send(delivery(bytes));
      },
    });
    const result = await new AmqpClient({ ...wire.config, timeoutMs: 2000 }).take("owned", { autoAck: true });
    expect(result?.bytes).toEqual(bytes);
    expect(wire.writes.filter((part) => part[0] === 8).length).toBe(1);
    expect(wire.closes()).toBe(1);
  });
  it("rejects an unsolicited heartbeat flood under the shared control budget", async () => {
    const controls = cat(...Array.from({ length: 129 }, () => packet(8, 0, new Uint8Array())));
    const wire = peer({ reply: controls });
    expect(await failure(new AmqpClient(wire.config).take("owned", { autoAck: true }))).toBeInstanceOf(
      AmqpOutcomeError,
    );
    expect(wire.closes()).toBe(1);
  });
  it("retires a stalled read at the operation deadline", async () => {
    const wire = peer();
    // Node22 unrefs AbortSignal.timeout. This finite test owner keeps the
    // deadline observable without depending on the protocol heartbeat timer.
    const alive = setTimeout(() => {}, 2000);
    try {
      const reason = await failure(new AmqpClient({ ...wire.config, timeoutMs: 100 }).take("owned", { autoAck: true }));
      expect(reason).toBeInstanceOf(AmqpOutcomeError);
      expect(wire.closes()).toBe(1);
    } finally {
      clearTimeout(alive);
    }
  });
});
