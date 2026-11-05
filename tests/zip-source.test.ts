import { describe, it } from "node:test";
import { expect } from "@std/expect";
import { decodeBase64 } from "@std/encoding/base64";
import { createArchiveLedger, openZip } from "../src/archive/zip.ts";
import type { ByteSourceType } from "../src/source.ts";
import passwordFixtures from "./fixtures/password/independent.json" with { type: "json" };
import aesFixtures from "./fixtures/aes/independent.json" with { type: "json" };

// Same independent Python stdlib fixture used by archive.test.ts: duplicate names,
// stored hello, 80000 deflated A bytes, UTF-8 coffee. No candidate writer is used.
const fixture =
  "UEsDBBQAAAAAAAAAIVCFEUoNCwAAAAsAAAAJAAAAZmlyc3QudHh0aGVsbG8gd29ybGRQSwMEFAAAAAgAAAAhUHnPp1NfAAAAgDgBAAkAAABsYXJnZS50eHTtwYEAAAAAwyC2+Usd4ApVAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAADAG1BLAwQUAAAAAAAAACFQG4FHEgkAAAAJAAAACQAAAGZpcnN0LnR4dGR1cGxpY2F0ZVBLAwQUAAAICAAAACFQsymFUwgAAAAGAAAACQAAAGNhZsOpLnR4dEvOT0tLTQUAUEsBAhQDFAAAAAAAAAAhUIURSg0LAAAACwAAAAkAAAAAAAAAAAAAAIABAAAAAGZpcnN0LnR4dFBLAQIUAxQAAAAIAAAAIVB5z6dTXwAAAIA4AQAJAAAAAAAAAAAAAACAATIAAABsYXJnZS50eHRQSwECFAMUAAAAAAAAACFQG4FHEgkAAAAJAAAACQAAAAAAAAAAAAAAgAG4AAAAZmlyc3QudHh0UEsBAhQDFAAACAgAAAAhULMphVMIAAAABgAAAAkAAAAAAAAAAAAAAIAB6AAAAGNhZsOpLnR4dFBLBQYAAAAABAAEANwAAAAXAQAAAAA=";
function source(bytes = decodeBase64(fixture)): ByteSourceType & { reads: number } {
  return {
    size: bytes.length,
    stability: "immutable",
    identity: "independent-python",
    reads: 0,
    async read(at, n, options) {
      options?.signal?.throwIfAborted();
      this.reads++;
      return bytes.slice(at, at + n);
    },
  };
}
describe("ZIP snapshot and opening authority", () => {
  it("captures source descriptors, bound read and name callback before the first await", async () => {
    const bytes = decodeBase64(fixture);
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const input = {
      size: bytes.length,
      stability: "immutable" as "immutable" | "caller",
      identity: "original",
      async read(at: number, n: number) {
        await barrier;
        return bytes.slice(at, at + n);
      },
    };
    const options = {
      maxEntries: 4,
      maxOutputBytes: 11,
      decodeName: (bytes: Uint8Array) => new TextDecoder().decode(bytes),
    };
    const pending = openZip(input, options);
    input.size = 1;
    input.stability = "caller";
    input.identity = "mutated";
    input.read = async () => {
      throw new Error("mutated source");
    };
    options.maxEntries = 0;
    options.maxOutputBytes = 0;
    options.decodeName = () => {
      throw new Error("mutated decoder");
    };
    release();
    const archive = await pending;
    expect(archive.entries.length).toBe(4);
    expect(archive.source).toEqual({ identity: "original", stability: "immutable" });
    expect(new TextDecoder().decode((await archive.read(0)).bytes)).toBe("hello world");
    expect(archive.plan(2, { length: 1 }).reason).toBe("budget-exceeded");
  });
  it("retains opening limits cumulatively, including execution split between headers and DEFLATE", async () => {
    const input = source(), archive = await openZip(input, { maxOutputBytes: 8, maxDecodedBytes: 8 });
    await archive.read(0, { length: 5 });
    input.reads = 0;
    expect(archive.plan(2, { length: 4, maxOutputBytes: 100, maxDecodedBytes: 100 }).reason).toBe("budget-exceeded");
    await expect(archive.read(2, { length: 4, maxOutputBytes: 100, maxDecodedBytes: 100 })).rejects.toMatchObject({
      code: "budget-exceeded",
    });
    expect(input.reads).toBe(0);
    const probe = await openZip(source());
    const index = probe.work;
    const limitedSource = source(), limited = await openZip(limitedSource, { maxSourceBytes: index.sourceBytes });
    limitedSource.reads = 0;
    await expect(limited.read(0, { length: 1, maxSourceBytes: 99999 })).rejects.toMatchObject({
      code: "budget-exceeded",
    });
    expect(limitedSource.reads).toBe(0);
    const requests = source(), requestLimited = await openZip(requests, { maxRequests: index.requests });
    requests.reads = 0;
    await expect(requestLimited.read(1, { length: 1, maxRequests: 999 })).rejects.toMatchObject({
      code: "budget-exceeded",
    });
    expect(requests.reads).toBe(0);
    const decoded = await openZip(source(), { maxDecodedBytes: 100 });
    await expect(decoded.read(1, { verify: true, maxDecodedBytes: 100000 })).rejects.toMatchObject({
      code: "budget-exceeded",
    });
  });
  it("retains opening/additional ledgers without charging the same owner twice", async () => {
    const ledger = createArchiveLedger({ maxOutputBytes: 8, maxDecodedBytes: 8 }),
      archive = await openZip(source(), { ledger });
    const first = await archive.read(0, { length: 5, ledger });
    expect(ledger.inspect().outputBytes).toBe(5);
    expect(ledger.inspect().decodedBytes).toBe(first.work.decodedBytes);
    await expect(archive.read(2, { length: 4 })).rejects.toMatchObject({ code: "budget-exceeded" });
    const extra = createArchiveLedger({ maxOutputBytes: 0 });
    await expect((await openZip(source())).read(0, { length: 1, ledger: extra })).rejects.toMatchObject({
      code: "budget-exceeded",
    });
  });
  it("keeps the parent abort authority even if callers replace their options or supply another signal", async () => {
    const parent = new AbortController(),
      options = { signal: parent.signal },
      input = source(),
      archive = await openZip(input, options);
    options.signal = new AbortController().signal;
    const reason = new Error("parent abort");
    parent.abort(reason);
    input.reads = 0;
    await expect(archive.read(0, { length: 0, signal: new AbortController().signal })).rejects.toBe(reason);
    expect(input.reads).toBe(0);
    const child = new AbortController(), second = await openZip(source());
    child.abort(reason);
    await expect(second.read(0, { length: 0, signal: child.signal })).rejects.toBe(reason);
  });
  it("captures a per-read codec callback before source await and retains original provider failure", async () => {
    const bytes = decodeBase64(fixture);
    let pause = false, release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const input: ByteSourceType = {
      size: bytes.length,
      stability: "caller",
      async read(at, n) {
        if (pause) await gate;
        return bytes.slice(at, at + n);
      },
    };
    const archive = await openZip(input),
      original = new Error("original codec"),
      replacement = new Error("replaced codec");
    pause = true;
    const opts = {
        length: 1,
        inflate: () => {
          throw original;
        },
      },
      pending = archive.read(1, opts);
    opts.inflate = () => {
      throw replacement;
    };
    release();
    await expect(pending).rejects.toBe(original);
    const failure = new Error("provider");
    let failing = false;
    const provider = source();
    const actual = provider.read.bind(provider);
    provider.read = async (at, n, opts) => {
      if (failing) throw failure;
      return actual(at, n, opts);
    };
    const opened = await openZip(provider);
    failing = true;
    await expect(opened.read(0, { length: 1 })).rejects.toBe(failure);
  });
  it("retains the opening output authority for ZipCrypto and authenticated AES reads", async () => {
    for (const selected of [passwordFixtures.stored, aesFixtures["aes256-ae2"]]) {
      const archive = await openZip(source(decodeBase64(selected.archive)), { maxOutputBytes: 1 }),
        password = decodeBase64(selected.password);
      const entry = archive.entries.find((entry) => entry.encrypted && entry.size > 2)!;
      await expect(
        archive.read(entry.id, { password, aes: { subtle: crypto.subtle }, length: 2, maxOutputBytes: 10000 }),
      ).rejects.toMatchObject({ code: "budget-exceeded" });
      expect((await archive.read(entry.id, { password, aes: { subtle: crypto.subtle }, length: 1 })).bytes.length).toBe(
        1,
      );
      await expect(archive.read(entry.id, { password, aes: { subtle: crypto.subtle }, length: 1 })).rejects
        .toMatchObject({ code: "budget-exceeded" });
    }
  });
  it("refuses malformed stability/identity/callback admission before I/O", async () => {
    const input = source();
    await expect(openZip({ ...input, stability: "foo" as "caller" })).rejects.toThrow();
    await expect(openZip({ ...input, identity: "x".repeat(8193) })).rejects.toThrow();
    await expect(openZip(input, { decodeName: "not a function" as unknown as (bytes: Uint8Array) => string })).rejects
      .toThrow();
    expect(input.reads).toBe(0);
    const unverified = { size: input.size, read: input.read.bind(input) };
    await expect(openZip(unverified)).rejects.toMatchObject({ code: "unsupported-profile" });
    const accepted = await openZip(unverified, { allowUnverifiedSource: true });
    expect(accepted.source.stability).toBe("unverified");
  });
});
