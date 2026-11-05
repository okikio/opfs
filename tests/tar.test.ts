import { describe, it } from "node:test";
import { expect } from "@std/expect";
import { decodeBase64 } from "@std/encoding/base64";
import { createBlobSource } from "../src/source.ts";
import { createArchiveLedger, openTar } from "../src/archive/tar.ts";
import { createTarStream, readTarStream } from "../src/archive/stream.ts";
import type { TarEntryType } from "../src/archive/tar.ts";
import fixtures from "./fixtures/tar/independent.json" with { type: "json" };

function stream(bytes: Uint8Array, cuts: number[] = [bytes.length]): ReadableStream<Uint8Array> {
  let offset = 0;
  let index = 0;
  return new ReadableStream({
    pull(controller) {
      if (offset === bytes.length) return controller.close();
      const end = cuts[index++] ?? bytes.length;
      controller.enqueue(bytes.subarray(offset, end));
      offset = end;
    },
  }, { highWaterMark: 0 });
}

async function collect(body: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let length = 0;
  for await (const chunk of body) {
    chunks.push(chunk.slice());
    length += chunk.length;
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}

function source(bytes: Uint8Array) {
  return createBlobSource(new Blob([new Uint8Array(bytes).buffer]));
}

/** Deliberately independent from production serialization, used only to corrupt one known producer header. */
function checksum(bytes: Uint8Array, offset: number): void {
  bytes.fill(32, offset + 148, offset + 156);
  let sum = 0;
  for (const byte of bytes.subarray(offset, offset + 512)) sum += byte;
  bytes.set(new TextEncoder().encode(`${sum.toString(8).padStart(6, "0")}\0 `), offset + 148);
}

/** Assemble control records around an independent POSIX header, never use the candidate writer as an oracle. */
function paxControl(records: readonly [string, string][], payload = new Uint8Array()): Uint8Array {
  const encoder = new TextEncoder();
  const text = records.map(([key, value]) => {
    const content = `${key}=${value}\n`;
    let length = encoder.encode(content).length + 3;
    while (length !== encoder.encode(content).length + String(length).length + 1) {
      length = encoder.encode(content).length + String(length).length + 1;
    }
    return `${length} ${content}`;
  }).join("");
  const metadata = encoder.encode(text);
  const template = decodeBase64(fixtures.pax.archive).subarray(2048, 2560);
  const block = (size: number, type: number) => {
    const header = template.slice();
    header[156] = type;
    header.set(encoder.encode(`${size.toString(8).padStart(11, "0")}\0`), 124);
    checksum(header, 0);
    return header;
  };
  const dataOffset = 512 + Math.ceil(metadata.length / 512) * 512;
  const output = new Uint8Array(dataOffset + 512 + Math.ceil(payload.length / 512) * 512 + 1024);
  output.set(block(metadata.length, 120));
  output.set(metadata, 512);
  output.set(block(0, 48), dataOffset);
  output.set(payload, dataOffset + 512);
  return output;
}

describe("TAR PAX and GNU metadata", () => {
  for (const [profile, fixture] of Object.entries(fixtures)) {
    it(`reads independent ${profile} metadata and full payloads`, async () => {
      const bytes = decodeBase64(fixture.archive);
      const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(bytes).buffer));
      expect(Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("")).toBe(fixture.sha256);
      const archive = await openTar(source(bytes));
      expect(archive.entries).toEqual(fixture.entries.map(({ body: _body, ...entry }, id) => ({ id, ...entry })));
      for (const entry of archive.entries) {
        if (entry.kind === "file") {
          expect((await archive.read(entry.id)).bytes).toEqual(decodeBase64(fixture.entries[entry.id]!.body));
        }
      }
      await expect(archive.read(2)).rejects.toMatchObject({ code: "unsupported-profile" });
      const seen: TarEntryType[] = [];
      const result = await readTarStream(stream(bytes), async (entry, body) => {
        seen.push(entry);
        expect(await collect(body)).toEqual(decodeBase64(fixture.entries[entry.id]!.body));
      });
      expect(seen).toEqual(archive.entries);
      expect(result).toMatchObject({ entries: 3, complete: true, integrity: "header-checksum-only" });
      expect(result.work.outputBytes).toBe(283);
    });
  }

  it("accepts every possible two-chunk split of independent PAX framing and bodies", async () => {
    const fixture = fixtures.pax;
    const bytes = decodeBase64(fixture.archive);
    // The producer pads to 10240 bytes. This is an exhaustive split of its actual bytes,
    // including length prefixes, UTF-8 continuation bytes, headers, payloads and end blocks.
    for (let cut = 1; cut < bytes.length; cut++) {
      let count = 0;
      await readTarStream(stream(bytes, [cut]), async (entry, body) => {
        const expected = fixture.entries[count++]!;
        const actual = await collect(body);
        if (
          entry.name !== expected.name || entry.link !== expected.link ||
          actual.toString() !== decodeBase64(expected.body).toString()
        ) {
          throw new Error(`Independent PAX fixture changed at split ${cut}, member ${entry.id}.`);
        }
      });
      if (count !== 3) throw new Error(`Missing entries at split ${cut}.`);
    }
  });

  it("bounds cumulative metadata/header work and rejects malformed, sparse, unsafe-size and dangling metadata", async () => {
    const bytes = decodeBase64(fixtures.pax.archive);
    await expect(openTar(source(bytes), { maxMetadataBytes: 1 })).rejects.toMatchObject({ code: "budget-exceeded" });
    await expect(openTar(source(bytes), { maxEntries: 1 })).rejects.toMatchObject({ code: "budget-exceeded" });
    const malformed = bytes.slice();
    malformed[512] = 48;
    await expect(openTar(source(malformed))).rejects.toMatchObject({ code: "invalid-archive" });
    const sparse = bytes.slice();
    const record = new TextEncoder().encode("25 GNU.sparse.size=12345\n");
    sparse.set(record, 512);
    await expect(openTar(source(sparse))).rejects.toMatchObject({ code: "unsupported-profile" });
    const binary = bytes.slice();
    binary[124] = 128;
    checksum(binary, 0);
    await expect(openTar(source(binary))).rejects.toMatchObject({ code: "unsupported-profile" });
    const gnu = decodeBase64(fixtures.gnu.archive);
    // One GNU long-name record followed by end markers, with no actual file header.
    const dangling = gnu.slice(0, 2048);
    dangling.fill(0, 1024);
    await expect(openTar(source(dangling))).rejects.toMatchObject({ code: "invalid-archive" });
    await expect(openTar(source(bytes.subarray(0, 700)))).rejects.toMatchObject({ code: "invalid-archive" });
  });

  it("uses PAX byte sizes over placeholder headers, bounds exact integers, and rejects unknown encodings", async () => {
    const bytes = paxControl([["path", "caf\u00e9.txt"], ["size", "3"]], new Uint8Array([0, 128, 255]));
    const archive = await openTar(source(bytes));
    expect(archive.entries[0]).toMatchObject({ name: "caf\u00e9.txt", size: 3 });
    expect((await archive.read(0)).bytes).toEqual(new Uint8Array([0, 128, 255]));
    await expect(openTar(source(paxControl([["size", "9007199254740992"]])))).rejects.toMatchObject({
      code: "unsupported-profile",
    });
    await expect(openTar(source(paxControl([["size", "-1"]])))).rejects.toMatchObject({ code: "invalid-archive" });
    await expect(openTar(source(paxControl([["hdrcharset", "BINARY"]])))).rejects.toMatchObject({
      code: "unsupported-profile",
    });
    const repeated = await openTar(source(paxControl([["path", "one"], ["path", "two"]])));
    expect(repeated.entries[0]?.name).toBe("two");
  });
});

describe("one-shot TAR stream ownership", () => {
  it("charges discarded payloads and shares aggregate output across members", async () => {
    const bytes = decodeBase64(fixtures.gnu.archive);
    await expect(readTarStream(stream(bytes), () => {}, { maxDecodedBytes: 276 })).rejects.toMatchObject({
      code: "budget-exceeded",
    });
    const listed = await readTarStream(stream(bytes), () => {});
    expect(listed.work.outputBytes).toBe(0);
    expect(listed.work.decodedBytes).toBeGreaterThanOrEqual(283);
    const ledger = createArchiveLedger({ maxOutputBytes: 280 });
    await expect(readTarStream(stream(bytes), async (_entry, body) => {
      await collect(body);
    }, { ledger })).rejects.toMatchObject({ code: "budget-exceeded" });
    const metadataLedger = createArchiveLedger({ maxDecodedBytes: 10 });
    await expect(readTarStream(stream(bytes), () => {}, { ledger: metadataLedger })).rejects.toMatchObject({
      code: "budget-exceeded",
    });
  });

  it("rejects late/repeated body use and drains a partially consumed member before advancing", async () => {
    const bytes = decodeBase64(fixtures.gnu.archive);
    let escaped: AsyncIterable<Uint8Array> | undefined;
    const names: string[] = [];
    await readTarStream(stream(bytes, [1700]), async (entry, body) => {
      names.push(entry.name);
      if (entry.id === 0) {
        escaped = body;
        for await (const chunk of body) {
          expect(chunk.length).toBeGreaterThan(0);
          break;
        }
        expect(() => body[Symbol.asyncIterator]()).toThrow(TypeError);
      } else if (entry.id === 1) expect(new TextDecoder().decode(await collect(body))).toBe("second");
    });
    expect(names.length).toBe(3);
    expect(() => escaped![Symbol.asyncIterator]()).toThrow(TypeError);
  });

  it("delivers a small selected prefix with a separate body chunk bound", async () => {
    let returned = 0;
    const result = await readTarStream(stream(decodeBase64(fixtures.gnu.archive)), async (_entry, body) => {
      for await (const chunk of body) {
        returned += chunk.length;
        break;
      }
      return false;
    }, { bodyChunkBytes: 3, maxOutputBytes: 3 });
    expect(returned).toBe(3);
    expect(result.work.outputBytes).toBe(3);
    expect(result.complete).toBe(false);
  });

  it("does not acquire another chunk while a visitor is paused; stops without draining", async () => {
    const bytes = decodeBase64(fixtures.gnu.archive);
    let pulls = 0;
    let cancelled = 0;
    let offset = 0;
    const input = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls++;
        controller.enqueue(bytes.subarray(offset, offset + 512));
        offset += 512;
      },
      cancel() {
        cancelled++;
      },
    }, { highWaterMark: 0 });
    const result = await readTarStream(input, async () => {
      const before = pulls;
      await new Promise((resolve) => setTimeout(resolve, 5));
      expect(pulls).toBe(before);
      return false;
    });
    expect(result.complete).toBe(false);
    expect(cancelled).toBe(1);
    expect(input.locked).toBe(false);
    expect(pulls).toBe(3); // GNU long metadata header + payload + member header; no member bytes.
  });

  it("cancels stalled reads on abort and releases locks for source/visitor/budget errors", async () => {
    const abort = new AbortController();
    let cancelled = false;
    const stalled = new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true;
      },
    }, { highWaterMark: 0 });
    const pending = readTarStream(stalled, () => {}, { signal: abort.signal });
    abort.abort(new Error("stop TAR"));
    await expect(pending).rejects.toThrow("stop TAR");
    expect(cancelled).toBe(true);
    expect(stalled.locked).toBe(false);
    const bytes = decodeBase64(fixtures.gnu.archive);
    for (const scenario of ["visitor", "source", "chunk", "requests", "source-bytes", "truncated"] as const) {
      const input = scenario === "source"
        ? new ReadableStream<Uint8Array>({
          pull() {
            throw new Error("source failure");
          },
        })
        : stream(scenario === "truncated" ? bytes.subarray(0, 1600) : bytes);
      await expect(readTarStream(input, () => {
        if (scenario === "visitor") throw new Error("visitor failure");
      }, {
        ...(scenario === "chunk" ? { maxChunkBytes: 2 } : {}),
        ...(scenario === "requests" ? { maxRequests: 0 } : {}),
        ...(scenario === "source-bytes" ? { maxSourceBytes: 0 } : {}),
      })).rejects.toBeInstanceOf(Error);
      expect(input.locked).toBe(false);
    }
    const badPolicy = stream(bytes);
    await expect(readTarStream(badPolicy, () => {}, { maxEntries: -1 })).rejects.toBeInstanceOf(RangeError);
    expect(badPolicy.locked).toBe(false);
    const primary = new Error("visitor primary");
    const cleanup = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes);
      },
      cancel() {
        throw new Error("cleanup secondary");
      },
    });
    await expect(readTarStream(cleanup, () => {
      throw primary;
    })).rejects.toBe(primary);
    expect(cleanup.locked).toBe(false);
  });
});

describe("streaming TAR writer", () => {
  it("emits PAX long paths/links and exact bodies with bounded incremental production", async () => {
    const payload = new TextEncoder().encode("hello tar");
    const name = "caf\u00e9/" + "n".repeat(120);
    const output = createTarStream([
      { name, size: payload.length, body: stream(payload, [2, 4]) },
      { name: "link", kind: "symbolic-link", link: "target/" + "l".repeat(120), size: 0 },
      { name: "empty/", kind: "directory", size: 0 },
    ]);
    const bytes = new Uint8Array(await new Response(output).arrayBuffer());
    const archive = await openTar(source(bytes));
    expect(archive.entries.map((entry) => [entry.name, entry.kind, entry.link])).toEqual([
      [name, "file", ""],
      ["link", "symbolic-link", "target/" + "l".repeat(120)],
      ["empty/", "directory", ""],
    ]);
    expect((await archive.read(0)).bytes).toEqual(payload);
  });

  it("does not pull a body until its header is consumed; cancellation closes the body and entry iterator", async () => {
    let pulls = 0;
    let closed = 0;
    let returned = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls++;
        controller.enqueue(new Uint8Array([1]));
      },
      cancel() {
        closed++;
      },
    }, { highWaterMark: 0 });
    async function* entries() {
      try {
        yield { name: "one", size: 2, body };
      } finally {
        returned = true;
      }
    }
    const output = createTarStream(entries());
    const reader = output.getReader();
    expect(pulls).toBe(0);
    expect((await reader.read()).value?.length).toBe(512);
    expect(pulls).toBe(0);
    expect((await reader.read()).value?.length).toBe(1);
    expect(pulls).toBe(1);
    await reader.cancel();
    reader.releaseLock();
    expect(closed).toBe(1);
    expect(returned).toBe(true);
    expect(body.locked).toBe(false);
  });

  it("rejects short/long bodies and metadata/output policies, and aborts a stalled body", async () => {
    for (const [size, body] of [[2, new Uint8Array([1])], [0, new Uint8Array([1])]] as const) {
      const input = stream(body);
      await expect(new Response(createTarStream([{ name: "entry", size, body: input }])).arrayBuffer()).rejects
        .toMatchObject({ code: "invalid-archive" });
      expect(input.locked).toBe(false);
    }
    await expect(
      new Response(createTarStream([{ name: "n".repeat(101), size: 0 }], { maxMetadataBytes: 0 })).arrayBuffer(),
    ).rejects.toMatchObject({ code: "budget-exceeded" });
    await expect(new Response(createTarStream([], { maxOutputBytes: 1 })).arrayBuffer()).rejects.toMatchObject({
      code: "budget-exceeded",
    });
    const abort = new AbortController();
    const input = new ReadableStream<Uint8Array>({}, { highWaterMark: 0 });
    const reader = createTarStream([{ name: "stalled", size: 1, body: input }], { signal: abort.signal }).getReader();
    await reader.read();
    const pending = reader.read();
    abort.abort(new Error("writer abort"));
    await expect(pending).rejects.toThrow("writer abort");
    reader.releaseLock();
    expect(input.locked).toBe(false);
  });
});
