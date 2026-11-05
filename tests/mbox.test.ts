import { describe, it } from "node:test";
import { expect } from "@std/expect";
import { decodeBase64 } from "@std/encoding/base64";
import { createBlobSource } from "../src/source.ts";
import type { ByteSourceType } from "../src/source.ts";
import { createArchiveLedger, openMbox } from "../src/archive/mbox.ts";
import { openMime } from "../src/archive/mime.ts";
import fixture from "./fixtures/mbox/independent.json" with { type: "json" };
const encode = (text: string): Uint8Array => new TextEncoder().encode(text);
const text = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);
const source = (bytes: Uint8Array): ByteSourceType => createBlobSource(new Blob([new Uint8Array(bytes).buffer]));
const mailbox = (message = "Subject: test\n\nbody\n"): Uint8Array =>
  encode(`From x@example.test Thu Jan  1 00:00:00 1970\n${message}\n`);
const crlf = (bytes: Uint8Array): Uint8Array => encode(text(bytes).replaceAll("\n", "\r\n"));

describe("explicit LF-native mailbox previews", () => {
  it("checks the retained independent mailbox byte hashes", async () => {
    for (const record of [fixture.mboxo, fixture.mboxrd]) {
      const bytes = decodeBase64(record.base64);
      const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(bytes).buffer));
      expect(Array.from(hash, (byte) => byte.toString(16).padStart(2, "0")).join("")).toBe(record.sha256);
    }
  });

  it("matches genuine Python mboxo producer and stored-byte consumer without irreversible unquoting", async () => {
    const bytes = decodeBase64(fixture.mboxo.base64);
    const box = await openMbox(source(bytes), { dialect: "mboxo" });
    expect(box.entries).toHaveLength(2);
    expect(box.work.sourceBytes).toBe(bytes.length);
    for (const entry of box.entries) {
      const raw = (await box.readRaw(entry.id)).bytes;
      expect(raw.slice(0, -1)).toEqual(decodeBase64(fixture.pythonStored[entry.id]!));
      const preview = await box.openMessage(entry.id, { trailing: "remove-one" });
      expect(await preview.source.read(0, preview.source.size)).toEqual(
        crlf(decodeBase64(fixture.pythonStored[entry.id]!)),
      );
      expect(preview.transformation.quoting).toBe("mboxo-stored-quotes");
    }
    const first = await box.openMessage(0, { trailing: "remove-one" });
    const mime = await openMime(first.source);
    expect(text((await mime.read(0)).bytes)).toContain(">From body\r\n>From original\r\n>>From original twice");
  });

  it("matches independent Git mboxrd consumer including its retained mailbox blank line", async () => {
    const box = await openMbox(source(decodeBase64(fixture.mboxrd.base64)), { dialect: "mboxrd" });
    for (const entry of box.entries) {
      const kept = await box.openMessage(entry.id, { trailing: "preserve" });
      expect(await kept.source.read(0, kept.source.size)).toEqual(
        crlf(
          decodeBase64(fixture.gitSplit[entry.id]!).slice(decodeBase64(fixture.gitSplit[entry.id]!).indexOf(10) + 1),
        ),
      );
      const stripped = await box.openMessage(entry.id, { trailing: "remove-one" });
      expect(await stripped.source.read(0, stripped.source.size)).toEqual(
        crlf(decodeBase64(fixture.original[entry.id]!)),
      );
    }
    const preview = await box.openMessage(1, { trailing: "remove-one" });
    const mime = await openMime(preview.source);
    expect(mime.entries[0]?.filename).toBe("test.bin");
    expect((await mime.read(0)).bytes).toEqual(new Uint8Array([0, 1, 2, 3, 255]));
  });

  it("keeps exact ranges through quote deletions and synthetic CR across exhaustive small scan cuts", async () => {
    const bytes = decodeBase64(fixture.mboxrd.base64);
    const oracle = crlf(decodeBase64(fixture.original[0]!));
    for (let chunk = 1; chunk <= 64; chunk++) {
      const box = await openMbox(source(bytes), { dialect: "mboxrd", maxChunkBytes: chunk, maxRequests: 10000 });
      const preview = await box.openMessage(0, {
        trailing: "remove-one",
        maxRequests: 100000,
        maxSourceBytes: 1000000,
      });
      for (let offset = 0; offset <= oracle.length; offset++) {
        const length = Math.min(7, oracle.length - offset);
        expect(await preview.source.read(offset, length)).toEqual(oracle.slice(offset, offset + length));
      }
    }
  });

  it("requires explicit dialect and LF framing, terminal blank lines and an initial envelope", async () => {
    for (
      const malformed of [
        "body\n\n",
        "From x date\nSubject: a\n\nbody\n",
        "From x date\r\n\r\n",
        "From \n\n",
      ]
    ) {
      await expect(openMbox(source(encode(malformed)), { dialect: "mboxrd" })).rejects.toBeInstanceOf(Error);
    }
    await expect(openMbox(source(mailbox()), { dialect: "mboxcl2" as "mboxrd" })).rejects.toMatchObject({
      code: "unsupported-profile",
    });
    const empty = await openMbox(source(new Uint8Array()), { dialect: "mboxo", maxMessages: 0 });
    expect(empty.entries).toEqual([]);
  });

  it("retains arbitrary envelope date text and does not trust Content-Length or duplicate IDs", async () => {
    const bytes = encode(
      "From sender arbitrary-date-zone\nContent-Length: 99999\nMessage-ID: <same>\n\na\n\nFrom sender another-date\nMessage-ID: <same>\n\nb\n\n",
    );
    const box = await openMbox(source(bytes), { dialect: "mboxo" });
    expect(box.entries.map((entry) => entry.envelope)).toEqual([
      "From sender arbitrary-date-zone",
      "From sender another-date",
    ]);
    expect(box.entries.map((entry) => entry.id)).toEqual([0, 1]);
    expect(Object.isFrozen(box.entries[0])).toBe(true);
  });

  it("bounds envelope metadata, message count, range map, scan and cumulative output before allocation", async () => {
    for (
      const limits of [{ maxEnvelopeBytes: 8 }, { maxMessages: 0 }, { maxMetadataBytes: 0 }, { maxSourceBytes: 2 }, {
        maxRequests: 0,
      }]
    ) {
      await expect(openMbox(source(mailbox()), { dialect: "mboxrd", ...limits })).rejects.toMatchObject({
        code: "budget-exceeded",
      });
    }
    const box = await openMbox(source(mailbox()), { dialect: "mboxrd" });
    await expect(box.openMessage(0, { trailing: "preserve", maxPieces: 0 })).rejects.toMatchObject({
      code: "budget-exceeded",
    });
    await expect(box.openMessage(0, { trailing: "preserve", maxMetadataBytes: 31 })).rejects.toMatchObject({
      code: "budget-exceeded",
    });
    const preview = await box.openMessage(0, { trailing: "preserve", maxOutputBytes: 2 });
    expect((await preview.source.read(0, 2)).length).toBe(2);
    await expect(preview.source.read(0, 1)).rejects.toMatchObject({ code: "budget-exceeded" });
    expect(preview.inspect().outputBytes).toBe(2);
    const ledger = createArchiveLedger({ maxSourceBytes: mailbox().length });
    const shared = await openMbox(source(mailbox()), { dialect: "mboxo", ledger });
    await expect(shared.openMessage(0, { trailing: "preserve", ledger })).rejects.toMatchObject({
      code: "budget-exceeded",
    });
  });

  it("captures source descriptors, preserves provenance, and propagates cancellation into range reads", async () => {
    const bytes = mailbox();
    const base = source(bytes);
    let seen: AbortSignal | undefined;
    const originalRead = base.read.bind(base);
    const mutable = {
      size: bytes.length,
      identity: "original",
      stability: "caller" as const,
      read: async (offset: number, length: number, options?: { signal?: AbortSignal }) => {
        seen = options?.signal;
        return await originalRead(offset, length, options);
      },
    };
    const box = await openMbox(mutable, { dialect: "mboxrd" });
    mutable.size = 0;
    mutable.identity = "changed";
    mutable.read = () => Promise.reject(new Error("mutated"));
    const preview = await box.openMessage(0, { trailing: "remove-one" });
    expect(preview.source.stability).toBe("caller");
    expect(preview.source.identity).toContain("original");
    const abort = new AbortController();
    await preview.source.read(0, 1, { signal: abort.signal });
    expect(seen).toBe(abort.signal);
    abort.abort(new Error("stop"));
    await expect(preview.source.read(0, 1, { signal: abort.signal })).rejects.toThrow("stop");
    await expect(preview.source.read(-1, 0)).rejects.toThrow();
    await expect(preview.source.read(preview.source.size + 1, 0)).rejects.toThrow();
  });

  it("distinguishes the required space and bounds a long line without buffering it", async () => {
    const body = "Fromage\n>Fromage\n" + ">".repeat(10000) + "From quoted\n" + "x".repeat(100000);
    const box = await openMbox(source(mailbox(`Subject: a\n\n${body}\n`)), { dialect: "mboxrd", maxChunkBytes: 65536 });
    expect(box.entries).toHaveLength(1);
    const preview = await box.openMessage(0, { trailing: "remove-one", maxPieces: 32 });
    const first = text(await preview.source.read(0, 100));
    expect(first).toContain("Fromage\r\n>Fromage\r\n");
    expect(preview.source.size).toBe(crlf(encode(`Subject: a\n\n${body}\n`)).length - 1);
    const tail = await preview.source.read(preview.source.size - 5, 5);
    expect(text(tail)).toBe("xxx\r\n");
  });

  it("refuses unverified sources unless explicitly accepted and never invents snapshot evidence", async () => {
    const bytes = mailbox();
    const base = source(bytes);
    const weak = { size: bytes.length, read: base.read.bind(base) };
    await expect(openMbox(weak, { dialect: "mboxo" })).rejects.toMatchObject({ code: "unsupported-profile" });
    const box = await openMbox(weak, { dialect: "mboxo", allowUnverifiedSource: true });
    const preview = await box.openMessage(0, { trailing: "preserve" });
    expect(box.source.stability).toBe("unverified");
    expect(preview.source.stability).toBeUndefined();
    await expect(openMime(preview.source)).rejects.toMatchObject({ code: "unsupported-profile" });
  });
});
