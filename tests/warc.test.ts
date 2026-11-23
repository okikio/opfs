import { describe, it } from "node:test";
import { expect } from "@std/expect";
import { decodeBase64 } from "@std/encoding/base64";
import { createBlobSource } from "../src/source.ts";
import type { ByteSourceType } from "../src/source.ts";
import { createArchiveLedger } from "../src/archive/record.ts";
import { openWarc } from "../src/archive/warc.ts";
import fixtures from "./fixtures/warc/independent.json" with { type: "json" };

const encode = (text: string): Uint8Array => new TextEncoder().encode(text);
const text = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);
const source = (bytes: Uint8Array): ByteSourceType => createBlobSource(new Blob([new Uint8Array(bytes).buffer]));

/** Authored framing mutations are independent from the genuine producer oracles. */
function record(body = "body", fields = "", type = "resource", length = encode(body).length): Uint8Array {
  return encode(
    `WARC/1.1\r\nWARC-Record-ID: <urn:test:one>\r\nWARC-Date: 2026\r\nWARC-Type: ${type}\r\nContent-Length: ${length}\r\n${fields}\r\n${body}\r\n\r\n`,
  );
}
function concat(...chunks: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(chunks.reduce((size, chunk) => size + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

describe("bounded WARC stored-block preview", () => {
  it("retains admitted source fields and read capability after indexing", async () => {
    const input = { ...source(record()) };
    const archive = await openWarc(input);
    input.size = 0;
    input.read = async () => {
      throw new Error("replacement must not be called");
    };
    expect(text((await archive.read(0)).bytes)).toBe("body");
    expect(archive.source.stability).toBe("immutable");
  });
  for (const fixture of fixtures.archives) {
    it(`reads independently produced WARC${fixture.version} bytes and verifies genuine block digests`, async () => {
      const bytes = decodeBase64(fixture.base64);
      const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(bytes).buffer));
      expect(Array.from(hash, (byte) => byte.toString(16).padStart(2, "0")).join("")).toBe(fixture.sha256);
      const archive = await openWarc(source(bytes));
      expect(archive.entries).toHaveLength(3);
      for (const [index, oracle] of fixture.records.entries()) {
        expect(oracle.digestPassed).toBe(true);
        expect(archive.entries[index]?.version).toBe(fixture.version);
        expect(archive.entries[index]?.recordId).toBe(oracle.recordId);
        expect((await archive.read(index)).bytes).toEqual(decodeBase64(oracle.blockBase64));
        const proof = await archive.verifyBlock(index, { subtle: crypto.subtle, maxOutputBytes: 0 });
        expect(proof.integrity).toBe("stored-block-digest");
        expect(proof.work.outputBytes).toBe(0);
        expect(proof.work.decodedBytes).toBe(decodeBase64(oracle.blockBase64).length);
      }
      const http = fixture.records[1]!;
      expect(http.blockDigest).not.toBe(http.payloadDigest);
      expect((await archive.read(1, { offset: 0, length: 8 })).integrity).toBe("none");
      expect(text((await archive.read(1)).bytes)).toMatch(/^HTTP\/1\.1/);
    });
  }

  it("preserves duplicate IDs, repeatable core relationships, unknown fields and folded UTF8", async () => {
    const fields =
      "WARC-Concurrent-To: <urn:test:a>\r\nwarc-concurrent-to: <urn:test:b>\r\nX-Note: café\r\n\tcontinued\r\nX-Note: second\r\n";
    const archive = await openWarc(source(concat(record("one", fields), record("two"))));
    expect(archive.entries.map((entry) => entry.id)).toEqual([0, 1]);
    expect(archive.entries[0]?.recordId).toBe(archive.entries[1]?.recordId);
    expect(archive.entries[0]?.fields.filter((field) => field.name.toLowerCase() === "warc-concurrent-to"))
      .toHaveLength(2);
    expect(archive.entries[0]?.fields.filter((field) => field.name === "X-Note").map((field) => field.value)).toEqual([
      "café continued",
      "second",
    ]);
    expect(text((await archive.read(1)).bytes)).toBe("two");
    expect(Object.isFrozen(archive.entries[0]?.fields[0])).toBe(true);
  });

  it("decodes UTF8 lines across bounded lookahead and preserves non-ASCII whitespace", async () => {
    const base = text(record("boundary"));
    const prefix = base.slice(0, base.indexOf("\r\n\r\n") + 2) + "X-Note: ";
    const padding = "a".repeat(1023 - encode(prefix).length);
    const archive = await openWarc(source(encode(`${prefix}${padding}é\u00a0\r\n\r\nboundary\r\n\r\n`)));
    expect(archive.entries[0]?.fields.at(-1)?.value).toBe(`${padding}é\u00a0`);
    expect(text((await archive.read(0)).bytes)).toBe("boundary");
  });

  it("rejects duplicate singleton fields without case-sensitive or first-wins escape", async () => {
    for (
      const fields of [
        "content-length: 4\r\n",
        "WARC-Date: 2026\r\n",
        "WARC-Block-Digest: a\r\nwarc-block-digest: b\r\n",
      ]
    ) {
      await expect(openWarc(source(record("body", fields)))).rejects.toMatchObject({ code: "invalid-archive" });
    }
  });

  it("uses byte lengths rather than payload delimiters, character counts or HTTP lengths", async () => {
    const body = "HTTP/1.1 200 OK\r\nContent-Length: 999999\r\n\r\ncafé\r\nWARC/1.1\r\n\r\n";
    const archive = await openWarc(source(concat(record(body), record("last"))));
    expect(text((await archive.read(0)).bytes)).toBe(body);
    expect(text((await archive.read(1)).bytes)).toBe("last");
    await expect(openWarc(source(record(body, "", "resource", body.length)))).rejects.toMatchObject({
      code: "invalid-archive",
    });
  });

  it("refuses malformed byte framing, unsafe lengths, missing fields and bad UTF8", async () => {
    const malformed = [
      new Uint8Array(),
      record().subarray(0, record().length - 1),
      encode(text(record()).replace("Content-Length: 4", "Content-Length: 9007199254740992")),
      encode(text(record()).replace("Content-Length: 4", "Content-Length: +4")),
      encode(text(record()).replace("WARC-Date: 2026\r\n", "")),
      encode(text(record()).replace("WARC/1.1\r\n", "WARC/1.1\n")),
      concat(encode("WARC/1.1\r\nX-Note: "), new Uint8Array([255]), record()),
    ];
    for (const bytes of malformed) {
      await expect(openWarc(source(bytes))).rejects.toMatchObject({ code: "invalid-archive" });
    }
    await expect(openWarc(source(concat(record(), encode("junk\r\n"))))).rejects.toMatchObject({
      code: "unsupported-profile",
    });
  });

  it("lists unsupported logical content without reconstructing it or following references", async () => {
    for (
      const [type, fields] of [["revisit", "WARC-Profile: https://example.invalid/profile\r\n"], ["continuation", ""], [
        "resource",
        "WARC-Segment-Number: 1\r\n",
      ], ["future-record", ""]]
    ) {
      const archive = await openWarc(source(record("opaque", fields, type)));
      expect(archive.entries[0]?.readable).toBe(false);
      await expect(archive.read(0)).rejects.toMatchObject({ code: "unsupported-profile" });
      await expect(archive.verifyBlock(0, { subtle: crypto.subtle })).rejects.toMatchObject({
        code: "unsupported-profile",
      });
    }
    const truncated = await openWarc(source(record("prefix", "WARC-Truncated: disconnect\r\n")));
    expect(truncated.entries[0]?.truncated).toBe("disconnect");
  });

  it("rejects compressed and separate ARC formats explicitly", async () => {
    await expect(openWarc(source(new Uint8Array([31, 139, 8, 0])))).rejects.toMatchObject({
      code: "unsupported-profile",
    });
    await expect(openWarc(source(encode("filedesc://example.arc 0.0.0.0 20261105000000 text/plain 0\n")))).rejects
      .toMatchObject({ code: "unsupported-profile" });
  });

  it("skips a large stored body while bounding index metadata, source work and request count", async () => {
    const prefix = record("", "", "resource", 100_000_000).subarray(
      0,
      record("", "", "resource", 100_000_000).length - 4,
    );
    const requests: [number, number][] = [];
    const archive = await openWarc({
      size: prefix.length + 100_000_000 + 4,
      stability: "caller",
      async read(offset, length) {
        requests.push([offset, length]);
        const result = new Uint8Array(length);
        for (let index = 0; index < length; index++) {
          const at = offset + index;
          if (at < prefix.length) result[index] = prefix[at]!;
          else if (at >= prefix.length + 100_000_000) {
            result[index] = [13, 10, 13, 10][at - prefix.length - 100_000_000]!;
          }
        }
        return result;
      },
    });
    expect(archive.entries[0]?.size).toBe(100_000_000);
    expect(archive.work.sourceBytes).toBeLessThan(2048);
    expect(requests).toHaveLength(3);
    await expect(archive.read(0)).rejects.toMatchObject({ code: "budget-exceeded" });
  });

  it("enforces independent header, field, line, record, metadata and aggregate work policies", async () => {
    for (
      const options of [
        { maxHeaderBytes: 8 },
        { maxLineBytes: 3 },
        { maxFields: 1 },
        { maxEntries: 0 },
        { maxMetadataBytes: 1 },
        { maxRequests: 0 },
        { maxSourceBytes: 1 },
        { maxDecodedBytes: 0 },
      ]
    ) {
      await expect(openWarc(source(record()), options)).rejects.toMatchObject({ code: "budget-exceeded" });
    }
    const ledger = createArchiveLedger({ maxOutputBytes: 3 });
    const archive = await openWarc(source(record()), { ledger });
    expect(text((await archive.read(0, { offset: 1, length: 3, ledger })).bytes)).toBe("ody");
    await expect(archive.read(0, { length: 1, ledger })).rejects.toMatchObject({ code: "budget-exceeded" });
    await expect(archive.read(0, { offset: 5 })).rejects.toBeInstanceOf(RangeError);
  });

  it("verifies independent SHA256 and rejects changed blocks, payload-only proof and noncanonical encoding", async () => {
    const fixture = fixtures.archives[1]!;
    const oracle = fixture.records[1]!;
    const body = text(decodeBase64(oracle.blockBase64));
    const archive = await openWarc(source(record(body, `WARC-Block-Digest: ${oracle.sha256BlockDigest}\r\n`)));
    expect((await archive.verifyBlock(0, { subtle: crypto.subtle })).algorithm).toBe("SHA-256");
    const tampered = await openWarc(
      source(record(body.replace("authored", "altered"), `WARC-Block-Digest: ${oracle.sha256BlockDigest}\r\n`)),
    );
    await expect(tampered.verifyBlock(0, { subtle: crypto.subtle })).rejects.toMatchObject({
      code: "checksum-mismatch",
    });
    for (
      const fields of [
        `WARC-Payload-Digest: ${oracle.payloadDigest}\r\n`,
        "WARC-Block-Digest: sha1:lowercase\r\n",
        "WARC-Block-Digest: md5:AAAA\r\n",
      ]
    ) {
      const unsupported = await openWarc(source(record(body, fields)));
      await expect(unsupported.verifyBlock(0, { subtle: crypto.subtle })).rejects.toMatchObject({
        code: "unsupported-profile",
      });
    }
    const noncanonical = oracle.sha256BlockDigest.slice(0, -1) + "B";
    const corrupt = await openWarc(source(record(body, `WARC-Block-Digest: ${noncanonical}\r\n`)));
    await expect(corrupt.verifyBlock(0, { subtle: crypto.subtle })).rejects.toMatchObject({
      code: "unsupported-profile",
    });
  });

  it("admits verification limits before allocation and returns no bytes on cancellation", async () => {
    let reads = 0;
    const native = source(record("body", "WARC-Block-Digest: sha1:ZCKKW3O2BHO7QOC2IM5EIELA6SJZV2ZD\r\n"));
    const archive = await openWarc({
      ...native,
      async read(...args) {
        reads++;
        return await native.read(...args);
      },
    });
    const before = reads;
    await expect(archive.verifyBlock(0, { subtle: crypto.subtle, maxVerifyBytes: 3 })).rejects.toMatchObject({
      code: "budget-exceeded",
    });
    await expect(archive.verifyBlock(0, { subtle: crypto.subtle, maxDecodedBytes: 3 })).rejects.toMatchObject({
      code: "budget-exceeded",
    });
    await expect(archive.verifyBlock(0, { subtle: crypto.subtle, maxVerifyBytes: 16 * 1024 * 1024 + 1 })).rejects
      .toBeInstanceOf(RangeError);
    expect(reads).toBe(before);
    const controller = new AbortController();
    controller.abort(new Error("stop"));
    await expect(archive.read(0, { signal: controller.signal })).rejects.toThrow("stop");
    expect(reads).toBe(before);
    const fail = new Error("source failure");
    await expect(openWarc({ size: 100, stability: "caller", read: () => Promise.reject(fail) })).rejects.toBe(fail);
  });

  it("does not return a preview or verification result when cancellation races with completion", async () => {
    const fixture = fixtures.archives[1]!;
    const bytes = decodeBase64(fixture.base64);
    const native = source(bytes);
    const readAbort = new AbortController();
    const reason = new Error("cancel after source completion");
    let active = false;
    const archive = await openWarc({
      ...native,
      async read(...args) {
        const result = await native.read(...args);
        if (active) readAbort.abort(reason);
        return result;
      },
    });
    active = true;
    await expect(archive.read(0, { signal: readAbort.signal })).rejects.toBe(reason);
    active = false;
    const hashAbort = new AbortController();
    const hashReason = new Error("cancel after digest completion");
    const subtle = {
      async digest(...args: Parameters<SubtleCrypto["digest"]>) {
        const result = await crypto.subtle.digest(...args);
        hashAbort.abort(hashReason);
        return result;
      },
    };
    await expect(archive.verifyBlock(0, { subtle, signal: hashAbort.signal })).rejects.toBe(hashReason);
  });

  it("requires stability evidence and checks actual native byte extents", async () => {
    const bytes = record();
    const unstable: ByteSourceType = {
      size: bytes.length,
      read: (offset, length) => Promise.resolve(bytes.slice(offset, offset + length)),
    };
    await expect(openWarc(unstable)).rejects.toMatchObject({ code: "unsupported-profile" });
    expect((await openWarc(unstable, { allowUnverifiedSource: true })).source.stability).toBe("unverified");
    await expect(openWarc({
      size: bytes.length,
      stability: "caller",
      async read() {
        const short = new Uint8Array(1);
        Object.defineProperty(short, "byteLength", {
          get() {
            throw new Error("shadow invoked");
          },
        });
        return short;
      },
    })).rejects.toMatchObject({ code: "invalid-archive" });
  });
});
