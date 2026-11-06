import { describe, it } from "node:test";
import { expect } from "@std/expect";
import { decodeBase64 } from "@std/encoding/base64";
import { createBlobSource } from "../src/source.ts";
import type { ByteSourceType } from "../src/source.ts";
import { createArchiveLedger } from "../src/archive/record.ts";
import { openMime } from "../src/archive/mime.ts";
import fixture from "./fixtures/mime/independent.json" with { type: "json" };
const encode = (text: string): Uint8Array => new TextEncoder().encode(text);
const text = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);
const source = (bytes: Uint8Array): ByteSourceType => createBlobSource(new Blob([new Uint8Array(bytes).buffer]));
const message = (body: string, headers = ""): Uint8Array => encode(`${headers}\r\n${body}`);
const multipart = (body: string): Uint8Array => message(body, 'Content-Type: multipart/mixed; boundary="outer"\r\n');

describe("bounded EML and MIME inspection", () => {
  it("reads Python email-produced nested bodies and RFC2231 attachment metadata", async () => {
    const bytes = decodeBase64(fixture.base64);
    const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(bytes).buffer));
    expect(Array.from(hash, (byte) => byte.toString(16).padStart(2, "0")).join("")).toBe(fixture.sha256);
    const archive = await openMime(source(bytes));
    expect(archive.entries.map((part) => part.type)).toEqual(fixture.parts.map((part) => part.type));
    expect(archive.entries.map((part) => part.parent)).toEqual([null, 0, 1, 1, 0]);
    expect(archive.work.sourceBytes).toBe(bytes.length);
    for (const [index, oracle] of fixture.parts.entries()) {
      expect(archive.entries[index]?.filename ?? null).toBe(oracle.filename);
      if (oracle.payloadBase64 !== null) {
        const result = await archive.read(index);
        expect(result.bytes).toEqual(decodeBase64(oracle.payloadBase64));
        expect(result.complete).toBe(true);
        expect(result.integrity).toBe("none");
      }
    }
    expect(archive.entries[4]?.filenameStatus).toBe("decoded");
    expect(text((await archive.readHeaders(0)).bytes)).toContain("Subject: A =?utf-8?");
    expect(Object.isFrozen(archive.entries[0]?.fields[0])).toBe(true);
  });

  it("preserves independent nested fixture behavior across exhaustive small source chunk ceilings", async () => {
    const bytes = decodeBase64(fixture.base64);
    const geometry = (await openMime(source(bytes))).entries.map((
      part,
    ) => [part.parent, part.type, part.offset, part.size]);
    for (let maximum = 1; maximum <= 80; maximum++) {
      const archive = await openMime(source(bytes), { maxChunkBytes: maximum, maxRequests: 10000 });
      expect(archive.entries.map((part) => [part.parent, part.type, part.offset, part.size])).toEqual(geometry);
      for (const id of [2, 3, 4]) {
        expect((await archive.read(id)).bytes).toEqual(decodeBase64(fixture.parts[id]!.payloadBase64!));
      }
    }
  });

  it("keeps attachment names and content IDs as metadata rather than paths or resolvers", async () => {
    const archive = await openMime(
      source(
        message(
          "payload",
          'Content-Disposition: attachment; filename="../../escape.txt"\r\nContent-ID: <same>\r\nContent-ID: <same>\r\n',
        ),
      ),
    );
    expect(archive.entries[0]?.filename).toBe("../../escape.txt");
    expect(archive.entries[0]?.fields.filter((field) => field.name === "Content-ID")).toHaveLength(2);
    expect(text((await archive.read(0)).bytes)).toBe("payload");
  });

  it("unfolds RFC5322 headers by removing CRLF while retaining WSP and duplicate uninterpreted fields", async () => {
    const archive = await openMime(
      source(message("body", "Subject: first\r\n\t second\r\nSubject: third\r\nReceived: a\r\nReceived: b\r\n")),
    );
    expect(archive.entries[0]?.fields[0]?.value).toBe(" first\t second");
    expect(archive.entries[0]?.fields.filter((field) => field.name === "Subject")).toHaveLength(2);
    for (const name of ["Content-Type", "Content-Transfer-Encoding", "Content-Disposition", "MIME-Version"]) {
      await expect(openMime(source(message("", `${name}: x\r\n${name.toLowerCase()}: y\r\n`)))).rejects.toMatchObject({
        code: "invalid-archive",
      });
    }
  });

  it("admits UTF8 headers explicitly and refuses bare LF, controls and malformed header framing", async () => {
    const bytes = message("body", "Subject: café\r\n");
    await expect(openMime(source(bytes))).rejects.toMatchObject({ code: "unsupported-profile" });
    expect((await openMime(source(bytes), { utf8Headers: true })).entries[0]?.fields[0]?.value).toBe(" café");
    for (
      const malformed of [
        "Subject: a\n\nbody",
        " orphan\r\n\r\nbody",
        "Bad Header: value\r\n\r\nbody",
        "X: \0\r\n\r\nbody",
        "X: no blank line\r\n",
      ]
    ) {
      // Space in a field name is forbidden; body contents remain opaque binary.
      await expect(openMime(source(encode(malformed)))).rejects.toMatchObject({ code: "invalid-archive" });
    }
  });

  it("supports quoted ASCII and strict single RFC2231 names without guessing unsupported continuations", async () => {
    for (
      const [parameter, expected] of [['filename="a\\"b.txt"', 'a"b.txt'], [
        "filename*=utf-8''caf%C3%A9.bin",
        "café.bin",
      ], ["filename*=us-ascii'en'readme.txt", "readme.txt"]]
    ) {
      const archive = await openMime(source(message("", `Content-Disposition: attachment; ${parameter}\r\n`)));
      expect(archive.entries[0]?.filename).toBe(expected);
    }
    for (
      const parameter of [
        'filename="=?utf-8?B?YQ==?="',
        "filename*0*=utf-8''abc; filename*1*=def",
        "filename*=iso-8859-1''caf%E9",
        "filename*=utf-8''bad%XY",
        "filename=a; filename*=utf-8''b",
      ]
    ) {
      const archive = await openMime(source(message("", `Content-Disposition: attachment; ${parameter}\r\n`)));
      expect(archive.entries[0]?.filenameStatus).toBe("unsupported");
      expect(archive.entries[0]?.filename).toBeUndefined();
      expect(archive.entries[0]?.fields[0]?.value).toContain(parameter);
    }
  });

  it("validates Base64 whole-part suffixes while prefix previews disclose pending examination", async () => {
    const headers = "Content-Transfer-Encoding: base64\r\n";
    const archive = await openMime(source(message("YWJjZA==", headers)));
    expect(text((await archive.read(0, { offset: 1, length: 2 })).bytes)).toBe("bc");
    expect((await archive.read(0, { offset: 4, length: 0 })).complete).toBe(true);
    await expect(archive.read(0, { offset: 5, length: 0 })).rejects.toBeInstanceOf(RangeError);
    expect((await archive.prefix(0, 1)).complete).toBe(false);
    expect(text((await archive.prefix(0, 10)).bytes)).toBe("abcd");
    expect((await archive.prefix(0, 10)).complete).toBe(true);
    expect((await archive.prefix(0, 0, { offset: 1_000_000 })).complete).toBe(false);
    const corrupt = await openMime(source(message("YWJj!", headers)));
    expect(text((await corrupt.prefix(0, 1)).bytes)).toBe("a");
    await expect(corrupt.read(0, { length: 1 })).rejects.toMatchObject({ code: "invalid-archive" });
    for (const wire of ["YQ=", "YR==", "YWJ=", "=AAA", "YQ==YQ==", "YQ==!", "YQ-_", "Y"]) {
      const malformed = await openMime(source(message(wire, headers)));
      await expect(malformed.read(0)).rejects.toMatchObject({ code: "invalid-archive" });
    }
  });

  it("decodes quoted-printable hard/soft breaks and transport padding with strict escapes", async () => {
    const headers = "Content-Transfer-Encoding: quoted-printable\r\n";
    const archive = await openMime(source(message("caf=C3=A9=\r\n text  \t\r\nend\t", headers)));
    expect(text((await archive.read(0)).bytes)).toBe("café text\r\nend");
    const maximumLine = await openMime(source(message("a".repeat(76) + "\r\n", headers)));
    expect(text((await maximumLine.read(0)).bytes)).toBe("a".repeat(76) + "\r\n");
    for (const wire of ["=GG", "=aF", "=", "line\n", "a".repeat(77)]) {
      const malformed = await openMime(source(message(wire, headers)));
      await expect(malformed.read(0)).rejects.toMatchObject({
        code: wire.length === 77 ? "budget-exceeded" : "invalid-archive",
      });
    }
  });

  it("excludes delimiter-owned CRLF and handles empty parts, preamble, epilogue and padding", async () => {
    const archive = await openMime(
      source(multipart("preamble\r\n--outer \t\r\n\r\nnot-newline\r\n--outer\r\n\r\n\r\n--outer--\t\r\nepilogue")),
    );
    expect(archive.entries).toHaveLength(3);
    expect(text((await archive.read(1)).bytes)).toBe("not-newline");
    expect((await archive.read(2)).bytes).toHaveLength(0);
    expect((await archive.prefix(2, 0)).complete).toBe(false);
  });

  it("does not mistake long payload lines with boundary-like prefixes for transport padding", async () => {
    const body = "--outer" + " ".repeat(1000) + "payload suffix";
    const archive = await openMime(source(multipart(`--outer\r\n\r\n${body}\r\n--outer--\r\n`)));
    expect(text((await archive.read(1)).bytes)).toBe(body);
  });

  it("rejects truncated inner multiparts, missing boundaries, prefix collisions and encoded containers", async () => {
    for (
      const body of [
        "--outer\r\nContent-Type: multipart/mixed; boundary=inner\r\n\r\n--inner\r\n\r\nbody\r\n--outer--\r\n",
        "--outer\r\n\r\nbody",
        "--outer--\r\n",
        "--outer\r\nContent-Type: multipart/mixed; boundary=outer-inner\r\n\r\n",
      ]
    ) {
      await expect(openMime(source(multipart(body)))).rejects.toBeInstanceOf(Error);
    }
    await expect(
      openMime(
        source(message("", "Content-Type: multipart/mixed; boundary=x\r\nContent-Transfer-Encoding: base64\r\n")),
      ),
    ).rejects.toMatchObject({ code: "unsupported-profile" });
    await expect(openMime(source(message("", "Content-Type: multipart/mixed; boundary=x; boundary=y\r\n")))).rejects
      .toMatchObject({ code: "invalid-archive" });
  });

  it("exposes signed/encrypted content without authenticity, rendering or decryption claims", async () => {
    const signed = await openMime(
      source(
        message(
          "--x\r\nContent-Type: text/html\r\n\r\n<script>inert()</script>\r\n--x--\r\n",
          "Content-Type: multipart/signed; boundary=x\r\n",
        ),
      ),
    );
    expect(signed.entries[1]?.protection).toBe("signed-unverified");
    expect((await signed.read(1)).integrity).toBe("none");
    const encrypted = await openMime(
      source(
        message(
          "Y2lwaGVy",
          "Content-Type: application/pkcs7-mime; smime-type=enveloped-data\r\nContent-Transfer-Encoding: base64\r\n",
        ),
      ),
    );
    expect(encrypted.entries[0]?.protection).toBe("encrypted-opaque");
    expect(text((await encrypted.read(0)).bytes)).toBe("cipher");
    const cms = await openMime(source(message("opaque", "Content-Type: application/pkcs7-mime\r\n")));
    expect(cms.entries[0]?.protection).toBe("opaque-security");
    const signedCms = await openMime(
      source(message("opaque", "Content-Type: application/pkcs7-mime; smime-type=signed-data\r\n")),
    );
    expect(signedCms.entries[0]?.protection).toBe("signed-unverified");
    const unknown = await openMime(source(message("opaque", "Content-Transfer-Encoding: x-custom\r\n")));
    expect(text((await unknown.readRaw(0)).bytes)).toBe("opaque");
    await expect(unknown.read(0)).rejects.toMatchObject({ code: "unsupported-profile" });
  });

  it("enforces parts/depth/header/padding/chunk limits and accounts discarded decoded prefix bytes", async () => {
    const bytes = decodeBase64(fixture.base64);
    for (
      const options of [
        { maxParts: 1 },
        { maxDepth: 0 },
        { maxHeaderBytes: 4 },
        { maxLineBytes: 1 },
        { maxFields: 0 },
        { maxMetadataBytes: 1 },
        { maxSourceBytes: 1 },
        { maxRequests: 0 },
        { maxDecodedBytes: 1 },
      ]
    ) {
      await expect(openMime(source(bytes), options)).rejects.toMatchObject({ code: "budget-exceeded" });
    }
    await expect(openMime(source(bytes), { maxChunkBytes: 0 })).rejects.toBeInstanceOf(RangeError);
    await expect(openMime(source(multipart("--outer    \r\n\r\nbody\r\n--outer--\r\n")), { maxBoundaryPadding: 3 }))
      .rejects.toMatchObject({ code: "budget-exceeded" });
    const archive = await openMime(source(message("YWJjZA==", "Content-Transfer-Encoding: base64\r\n")));
    const result = await archive.prefix(0, 1, { offset: 2 });
    expect(text(result.bytes)).toBe("c");
    expect(result.work.decodedBytes).toBe(3);
    expect(result.work.outputBytes).toBe(1);
    const ledger = createArchiveLedger({ maxOutputBytes: 1 });
    await archive.prefix(0, 1, { ledger });
    await expect(archive.prefix(0, 1, { ledger })).rejects.toMatchObject({ code: "budget-exceeded" });
  });

  it("does not return decoded bytes if cancellation races with source completion", async () => {
    const bytes = message("body");
    const controller = new AbortController();
    const reason = new Error("cancel after read");
    let active = false;
    const archive = await openMime({
      size: bytes.length,
      stability: "caller",
      async read(offset, length) {
        const result = bytes.slice(offset, offset + length);
        if (active) controller.abort(reason);
        return result;
      },
    });
    active = true;
    await expect(archive.read(0, { signal: controller.signal })).rejects.toBe(reason);
  });

  it("requires stable source evidence, captures source capabilities and propagates cancellation without disposal", async () => {
    const bytes = message("body");
    const mutable = {
      size: bytes.length,
      stability: "caller" as const,
      read: async (offset: number, length: number) => bytes.slice(offset, offset + length),
    };
    const archive = await openMime(mutable);
    mutable.size = 0;
    mutable.read = async () => {
      throw new Error("replaced");
    };
    expect(text((await archive.read(0)).bytes)).toBe("body");
    const unstable = {
      size: bytes.length,
      read: async (offset: number, length: number) => bytes.slice(offset, offset + length),
    };
    await expect(openMime(unstable)).rejects.toMatchObject({ code: "unsupported-profile" });
    expect((await openMime(unstable, { allowUnverifiedSource: true })).source.stability).toBe("unverified");
    const controller = new AbortController();
    const reason = new Error("cancel");
    controller.abort(reason);
    await expect(archive.read(0, { signal: controller.signal })).rejects.toBe(reason);
    await expect(archive.prefix(0, 0, { signal: controller.signal })).rejects.toBe(reason);
    const fail = new Error("source failed");
    await expect(openMime({ size: 100, stability: "caller", read: () => Promise.reject(fail) })).rejects.toBe(fail);
    await expect(openMime({
      size: 100,
      stability: "caller",
      async read() {
        const result = new Uint8Array(1);
        Object.defineProperty(result, "byteLength", { value: 100 });
        return result;
      },
    })).rejects.toMatchObject({ code: "invalid-archive" });
  });
});
