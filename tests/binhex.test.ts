import { describe, it } from "node:test";
import { expect } from "@std/expect";
import { decodeBase64 } from "@std/encoding/base64";
import native from "./fixtures/binhex/independent.json" with { type: "json" };
import negatives from "./fixtures/binhex/negative.json" with { type: "json" };
import { openZip } from "../src/archive/zip.ts";
import { ArchiveError, createArchiveLedger, openBinHex } from "../src/archive/binhex.ts";
import type { ByteSourceType } from "../src/source.ts";

// Authored controls use a table recurrence independent of the production bit loop.
function crc(bytes: Uint8Array): number {
  const table = Uint16Array.from({ length: 256 }, (_, value) => {
    value <<= 8;
    for (let bit = 0; bit < 8; bit++) value = (value & 0x8000) ? (value << 1) ^ 0x1021 : value << 1;
    return value & 65535;
  });
  let sum = 0;
  for (const byte of bytes) sum = ((sum << 8) ^ table[((sum >>> 8) ^ byte) & 255]!) & 65535;
  return sum;
}
function join(...parts: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((sum, bytes) => sum + bytes.length, 0));
  let at = 0;
  for (const bytes of parts) {
    result.set(bytes, at);
    at += bytes.length;
  }
  return result;
}
const text = (value: string) => new TextEncoder().encode(value);
const word = (value: number) => Uint8Array.of(value >>> 8, value & 255);
function wire(raw: Uint8Array, banner = "(This file must be converted with BinHex 4.0)"): Uint8Array {
  const alphabet = "!\"#$%&'()*+,-012345689@ABCDEFGHIJKLMNPQRSTUVXYZ[`abcdefhijklmpqr";
  // Encode literal markers only. RLE runs get dedicated authored controls below.
  const packed = [...raw].flatMap((byte) => byte === 0x90 ? [byte, 0] : [byte]);
  return packedWire(Uint8Array.from(packed), banner, alphabet);
}
function packedWire(
  packed: Uint8Array,
  banner = "(This file must be converted with BinHex 4.0)",
  alphabet = "!\"#$%&'()*+,-012345689@ABCDEFGHIJKLMNPQRSTUVXYZ[`abcdefhijklmpqr",
): Uint8Array {
  let bits = 0, count = 0, body = ":";
  for (const byte of packed) {
    bits = (bits << 8) | byte;
    count += 8;
    while (count >= 6) {
      count -= 6;
      body += alphabet[(bits >>> count) & 63];
    }
    bits &= (1 << count) - 1;
  }
  if (count) body += alphabet[(bits << (6 - count)) & 63];
  body += ":";
  return text(banner + "\n\n" + (body.match(/.{1,64}/g) ?? []).join("\n") + "\n");
}
function fixture(data = text("123456789"), resource = text("fork"), name = "test.bin") {
  const encoded = text(name), header = new Uint8Array(encoded.length + 20), fields = new DataView(header.buffer);
  header[0] = encoded.length;
  header.set(encoded, 1);
  header.set(text("TESTOPFS"), encoded.length + 2);
  fields.setUint16(encoded.length + 10, 0x8000);
  fields.setUint32(encoded.length + 12, data.length);
  fields.setUint32(encoded.length + 16, resource.length);
  const raw = join(header, word(crc(header)), data, word(crc(data)), resource, word(crc(resource)));
  return { raw, bytes: wire(raw), header, data, resource, dataAt: header.length + 2 };
}
function source(
  bytes: Uint8Array,
  action?: (offset: number, length: number, signal?: AbortSignal) => void,
): ByteSourceType {
  return {
    size: bytes.length,
    stability: "caller",
    identity: "authored/binhex",
    async read(offset, length, options) {
      action?.(offset, length, options?.signal);
      return bytes.slice(offset, offset + length);
    },
  };
}
async function collect(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const result: Uint8Array[] = [];
  for await (const bytes of stream) result.push(bytes);
  return join(...result);
}

describe("bounded BinHex fork previews", () => {
  it("matches every unchanged genuine native fork and explicitly refuses observed Perl padding", async () => {
    const perlWithoutPadding = new Set(["runs", "tail2", "tail6", "tail9"]);
    for (const fixture of native.fixtures) {
      const bytes = decodeBase64(fixture.archive.base64);
      if (fixture.producer === "macutils") {
        await expect(openBinHex(source(bytes))).rejects.toBeInstanceOf(ArchiveError);
      }
      const archive = await openBinHex(source(bytes), { preamble: "rfc1741-or-macutils" });
      expect(archive.name).toBe(fixture.name);
      expect(archive.flags).toBe(32768);
      expect(archive.dataSize).toBe(fixture.data.bytes);
      expect(archive.resourceSize).toBe(fixture.resource.bytes);
      expect(archive.preambleProfile).toBe(fixture.producer === "macutils" ? "macutils" : "rfc1741");
      expect((await archive.read("data")).bytes).toEqual(decodeBase64(fixture.data.base64));
      if (fixture.producer === "perl" && !perlWithoutPadding.has(fixture.case)) {
        await expect(archive.read("resource")).rejects.toMatchObject({ code: "invalid-archive" });
        await expect(archive.verify()).rejects.toMatchObject({ code: "invalid-archive" });
      } else {
        const resource = await archive.read("resource");
        expect(resource.bytes).toEqual(decodeBase64(fixture.resource.base64));
        expect(resource.terminal).toBe("verified");
      }
      if (fixture.producer === "perl") {
        const compatible = await openBinHex(source(bytes), { padding: "convert-binhex" });
        const resource = await compatible.read("resource");
        expect(resource.bytes).toEqual(decodeBase64(fixture.resource.base64));
        expect(resource.paddingPolicy).toBe("convert-binhex");
        expect(resource.terminalPaddingBytes).toBe(
          perlWithoutPadding.has(fixture.case)
            ? 0
            : ["empty", "many", "tail3", "tail7", "nested"].includes(fixture.case)
            ? 1
            : 2,
        );
        expect((await compatible.read("data")).terminalPaddingBytes).toBeNull();
      }
    }
  });
  it("matches separately authored native C header and fork CRC rejection controls", async () => {
    for (const control of negatives.controls) {
      expect(control.native.code).not.toBe(0);
      const input = source(decodeBase64(control.base64));
      if (control.name.startsWith("header")) {
        await expect(openBinHex(input)).rejects.toMatchObject({ code: "checksum-mismatch" });
      } else {
        const archive = await openBinHex(input);
        await expect(archive.verify()).rejects.toMatchObject({ code: "checksum-mismatch" });
      }
    }
  });
  it("opens a genuine nested ZIP from a replaying data-fork source", async () => {
    const fixture = native.fixtures.find((value) => value.case === "nested" && value.producer === "macutils")!;
    const archive = await openBinHex(source(decodeBase64(fixture.archive.base64)), { preamble: "rfc1741-or-macutils" });
    const zip = await openZip(archive.member("data"));
    const member = zip.entries.find((value) => value.name === "inside.txt")!;
    const original = decodeBase64(native.nestedOriginal.base64);
    expect((await zip.read(member.id)).bytes).toEqual(original);
    expect((await archive.read("resource")).bytes).toEqual(decodeBase64(fixture.resource.base64));
  });
  it("checks the independent CRC vector and keeps component evidence separate", async () => {
    expect(crc(text("123456789"))).toBe(0x31c3);
    const f = fixture(), archive = await openBinHex(source(f.bytes));
    expect(archive.name).toBe("test.bin");
    expect(archive.flags).toBe(0x8000);
    expect(archive.type).toEqual(text("TEST"));
    expect(archive.creator).toEqual(text("OPFS"));
    const selected = await archive.read("data", { offset: 2, length: 3 });
    expect(selected.bytes).toEqual(f.data.slice(2, 5));
    expect(selected).toMatchObject({
      header: "crc16-verified",
      data: "crc16-verified",
      resource: "pending",
      terminal: "pending",
    });
    const resource = await archive.read("resource");
    expect(resource.bytes).toEqual(f.resource);
    expect(resource).toMatchObject({ data: "crc16-verified", resource: "crc16-verified", terminal: "verified" });
    expect((await archive.verify()).work.outputBytes).toBe(0);
  });
  it("scans bounded text before the exact comment and observes explicit native-banner compatibility", async () => {
    const f = fixture(), preceding = text("mail preface\r\nnot the comment\r\n");
    const complete = join(preceding, f.bytes), prefixBytes = complete.indexOf(58) + 1;
    expect((await openBinHex(source(complete), { maxPreambleBytes: prefixBytes })).name).toBe("test.bin");
    await expect(openBinHex(source(complete), { maxPreambleBytes: prefixBytes - 1 })).rejects.toMatchObject({
      code: "budget-exceeded",
    });
    await expect(openBinHex(source(join(preceding, f.bytes)), { maxPreambleBytes: 10 })).rejects.toMatchObject({
      code: "budget-exceeded",
    });
    const bytes = wire(f.raw, "(This file must be converted; you knew that already.)");
    await expect(openBinHex(source(bytes))).rejects.toBeDefined();
    const archive = await openBinHex(source(bytes), { preamble: "rfc1741-or-macutils" });
    expect(archive.preambleProfile).toBe("macutils");
    expect((await archive.read("data")).bytes).toEqual(f.data);
  });
  it("owns raw metadata and callback input before reentrant mutation", async () => {
    const f = fixture();
    const archive = await openBinHex(source(f.bytes), {
      decodeName(bytes) {
        bytes.fill(0);
        return "renamed";
      },
    });
    const raw = archive.rawName;
    raw.fill(0);
    const type = archive.type;
    type.fill(0);
    expect(archive.rawName).toEqual(text("test.bin"));
    expect(archive.type).toEqual(text("TEST"));
    expect((await archive.read("data")).bytes).toEqual(f.data);
  });
  it("decodes every small source-window size without borrowing scratch across reads", async () => {
    const f = fixture(Uint8Array.of(0x90, 0, 1, 0x90, 255), text("abc"));
    for (let size = 1; size <= f.bytes.length; size++) {
      const scratch = new Uint8Array(size);
      const input: ByteSourceType = {
        size: f.bytes.length,
        stability: "caller",
        async read(offset, length) {
          scratch.fill(255);
          scratch.set(f.bytes.subarray(offset, offset + length));
          return scratch.subarray(0, length);
        },
      };
      const archive = await openBinHex(input, { inputChunkBytes: size, maxRequests: 10000 });
      expect((await archive.read("data")).bytes).toEqual(f.data);
      expect((await archive.read("resource")).bytes).toEqual(f.resource);
    }
  });
  it("decodes runs across component boundaries and refuses impossible run/tail framing", async () => {
    const f = fixture(new Uint8Array(257), new Uint8Array(511));
    // An independent simple run emitter works over the complete binary envelope,
    // including CRC bytes. No parser component reset is available to this encoder.
    const packed: number[] = [];
    for (let at = 0; at < f.raw.length;) {
      const byte = f.raw[at]!;
      let end = at + 1;
      while (end < f.raw.length && f.raw[end] === byte && end - at < 255) end++;
      const count = end - at;
      packed.push(byte);
      if (byte === 0x90) packed.push(0);
      if (count > 1) packed.push(0x90, count);
      at = end;
    }
    for (const size of [1, 2, 3, 7, 31]) {
      const archive = await openBinHex(source(packedWire(Uint8Array.from(packed))), {
        inputChunkBytes: size,
        maxRequests: 10000,
      });
      expect((await archive.read("data")).bytes).toEqual(f.data);
      expect((await archive.read("resource")).bytes).toEqual(f.resource);
    }
    for (const bytes of [Uint8Array.of(0x90, 3), Uint8Array.of(0x90), Uint8Array.of(1, 0x90, 1)]) {
      await expect(openBinHex(source(packedWire(bytes)))).rejects.toMatchObject({ code: "invalid-archive" });
    }
    await expect(openBinHex(source(text("(This file must be converted with BinHex 4.0)\n:!:\n")))).rejects
      .toMatchObject({ code: "invalid-archive" });
    await expect(openBinHex(source(text("(This file must be converted with BinHex 4.0)\n:!!~:\n")))).rejects
      .toMatchObject({ code: "invalid-archive" });
  });
  it("admits only the exact observed literal packed-zero producer padding", async () => {
    const f = fixture(), packed = Uint8Array.from([...f.raw].flatMap((byte) => byte === 0x90 ? [byte, 0] : [byte]));
    const padding = (3 - packed.length % 3) % 3;
    expect(padding).toBeGreaterThan(0);
    const compatible = await openBinHex(source(packedWire(join(packed, new Uint8Array(padding)))), {
      padding: "convert-binhex",
    });
    expect(await compatible.verify()).toMatchObject({
      terminal: "verified",
      terminalPaddingBytes: padding,
      paddingPolicy: "convert-binhex",
    });
    for (
      const suffix of [
        new Uint8Array(),
        new Uint8Array(padding + 3),
        Uint8Array.of(1),
        Uint8Array.of(0x90, 2),
        Uint8Array.of(0x90, 0),
      ]
    ) {
      const archive = await openBinHex(source(packedWire(join(packed, suffix))), { padding: "convert-binhex" });
      await expect(archive.verify()).rejects.toMatchObject({ code: "invalid-archive" });
    }
    const empty = fixture(new Uint8Array(), new Uint8Array());
    const prefix = Uint8Array.from([...empty.raw.slice(0, -4)].flatMap((byte) => byte === 0x90 ? [byte, 0] : [byte]));
    const extraRun = await openBinHex(source(packedWire(join(prefix, Uint8Array.of(0, 0x90, 5)))), {
      padding: "convert-binhex",
    });
    await expect(extraRun.verify()).rejects.toMatchObject({ code: "invalid-archive" });
    const strict = await openBinHex(source(packedWire(join(packed, new Uint8Array(padding)))));
    await expect(strict.verify()).rejects.toMatchObject({ code: "invalid-archive" });
  });
  it("keeps a prefix pending and finds corruption in its unselected suffix", async () => {
    const f = fixture(), damaged = f.raw.slice();
    damaged[f.dataAt + 8] = damaged[f.dataAt + 8]! ^ 1;
    const archive = await openBinHex(source(wire(damaged)));
    const prefix = await archive.read("data", { length: 2, verify: false });
    expect(prefix.bytes).toEqual(f.data.slice(0, 2));
    expect(prefix.data).toBe("pending");
    await expect(archive.read("data", { length: 2 })).rejects.toMatchObject({ code: "checksum-mismatch" });
    await expect(archive.read("resource")).rejects.toMatchObject({ code: "checksum-mismatch" });
  });
  it("does not claim resource or terminal verification from data-fork success", async () => {
    const f = fixture(), damaged = f.raw.slice();
    damaged[damaged.length - 1] = damaged[damaged.length - 1]! ^ 1;
    const archive = await openBinHex(source(wire(damaged)));
    expect((await archive.read("data")).bytes).toEqual(f.data);
    await expect(archive.verify()).rejects.toMatchObject({ code: "checksum-mismatch" });
    const trailing = await openBinHex(source(join(f.bytes, text("extra"))));
    expect((await trailing.read("data")).terminal).toBe("pending");
    await expect(trailing.verify()).rejects.toMatchObject({ code: "invalid-archive" });
  });
  it("verifies empty forks and rejects every truncation during full verification", async () => {
    const f = fixture(new Uint8Array(), new Uint8Array());
    expect((await (await openBinHex(source(f.bytes))).verify()).terminal).toBe("verified");
    const colon = f.bytes.lastIndexOf(58);
    for (let end = 0; end <= colon; end++) {
      let failed = false;
      try {
        await (await openBinHex(source(f.bytes.slice(0, end)))).verify();
      } catch {
        failed = true;
      }
      expect(failed).toBe(true);
    }
  });
  it("retains opening source/options/ledger authority and deduplicates the same nested owner", async () => {
    const f = fixture(), ledger = createArchiveLedger({ maxSourceBytes: 100000, maxDecodedBytes: 100000 });
    const input = source(f.bytes), opts = { ledger, inputChunkBytes: 7, maxSourceBytes: 100000 };
    const pending = openBinHex(input, opts);
    input.read = async () => {
      throw new Error("mutated read");
    };
    opts.inputChunkBytes = 1;
    opts.maxSourceBytes = 0;
    const archive = await pending;
    const before = ledger.inspect();
    const direct = await archive.read("data", { verify: false, length: 2, ledger });
    const delta = ledger.inspect().sourceBytes - before.sourceBytes;
    expect(delta).toBe(direct.work.sourceBytes);
    const nested = archive.member("data", { ledger });
    const start = ledger.inspect().sourceBytes;
    expect(await nested.read(0, 2)).toEqual(f.data.slice(0, 2));
    expect(ledger.inspect().sourceBytes - start).toBe(direct.work.sourceBytes);
  });
  it("refuses exhausted output/source/request and retained opening allowance before forbidden effects", async () => {
    const f = fixture();
    let calls = 0;
    const archive = await openBinHex(source(f.bytes, () => {
      calls++;
    }));
    for (const limits of [{ maxOutputBytes: 0 }, { maxSourceBytes: 0 }, { maxRequests: 0 }]) {
      const before = calls;
      await expect(archive.read("data", { length: 1, ...limits })).rejects.toMatchObject({ code: "budget-exceeded" });
      expect(calls).toBe(before);
    }
    const limited = await openBinHex(source(f.bytes), { maxSourceBytes: f.bytes.length });
    await expect(limited.read("data")).rejects.toMatchObject({ code: "budget-exceeded" });
  });
  it("charges resource replay/discarded data and RLE expansion rather than selected output alone", async () => {
    const f = fixture(text("a".repeat(1000)), text("resource"));
    const archive = await openBinHex(source(f.bytes));
    await expect(archive.read("resource", { length: 1, maxDecodedBytes: 50 })).rejects.toMatchObject({
      code: "budget-exceeded",
    });
    const result = await archive.read("resource", { length: 1 });
    expect(result.work.decodedBytes).toBe(f.raw.length);
    expect(result.work.outputBytes).toBe(1);
  });
  it("honors abort from foreign reserve callbacks before source I/O and preserves provider errors", async () => {
    const f = fixture(), controller = new AbortController(), reason = new Error("abort ledger");
    let calls = 0;
    const ledger = {
      inspect: () => ({ sourceBytes: 0, requests: 0, decodedBytes: 0, outputBytes: 0 }),
      reserve() {
        controller.abort(reason);
      },
    };
    await expect(openBinHex(
      source(f.bytes, () => {
        calls++;
      }),
      { ledger, signal: controller.signal },
    )).rejects.toBe(reason);
    expect(calls).toBe(0);
    const sentinel = new Error("provider");
    await expect(openBinHex({ size: 10, stability: "caller", read: () => Promise.reject(sentinel) })).rejects.toBe(
      sentinel,
    );
    const parent = new AbortController(), archive = await openBinHex(source(f.bytes), { signal: parent.signal });
    const nested = archive.member("data");
    parent.abort(reason);
    await expect(nested.read(0, 1)).rejects.toBe(reason);
  });
  it("streams provisional chunks under pull backpressure and verifies only on finished", async () => {
    const f = fixture(), archive = await openBinHex(source(f.bytes));
    const output = archive.stream("resource", { length: 2 });
    expect(await collect(output.stream)).toEqual(f.resource.slice(0, 2));
    expect(await output.finished).toMatchObject({
      data: "crc16-verified",
      resource: "crc16-verified",
      terminal: "verified",
      cancelled: false,
    });
    const prefix = archive.stream("data", { length: 2, verify: false });
    expect(await collect(prefix.stream)).toEqual(f.data.slice(0, 2));
    expect((await prefix.finished).data).toBe("pending");
  });
  it("cancels pending output without closing the borrowed source", async () => {
    const f = fixture(), archive = await openBinHex(source(f.bytes));
    const output = archive.stream("data"), reader = output.stream.getReader();
    expect((await reader.read()).value).toEqual(f.data);
    await reader.cancel();
    reader.releaseLock();
    expect(await output.finished).toMatchObject({
      cancelled: true,
      data: "pending",
      resource: "pending",
      terminal: "pending",
    });
    expect((await archive.read("data")).bytes).toEqual(f.data);
  });
  it("assigns active work before a reentrant source cancel and retains independent failure", async () => {
    const f = fixture(), sentinel = new Error("provider after cancel");
    const callbacks: { cancel?: () => Promise<void>; cancelling?: Promise<void> } = {};
    const input: ByteSourceType = {
      size: f.bytes.length,
      stability: "caller",
      async read(offset, length) {
        if (callbacks.cancel) {
          callbacks.cancelling = callbacks.cancel();
          void callbacks.cancelling.catch(() => {});
          throw sentinel;
        }
        return f.bytes.slice(offset, offset + length);
      },
    };
    const archive = await openBinHex(input), output = archive.stream("data");
    const reader = output.stream.getReader();
    callbacks.cancel = () => reader.cancel();
    const pending = reader.read();
    expect((await pending).done).toBe(true);
    await expect(output.finished).rejects.toBe(sentinel);
    await expect(callbacks.cancelling).rejects.toBe(sentinel);
    reader.releaseLock();
  });
});
