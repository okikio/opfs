import { describe, it } from "node:test";
import { expect } from "@std/expect";
import { runInNewContext } from "node:vm";
import { decodeBase64 } from "@std/encoding/base64";
import { createNativeTink, createTink, TinkError } from "../src/crypto/tink.ts";
import { createByteSource } from "../src/source.ts";
import { openZip } from "../src/archive/zip.ts";
import vectors from "./fixtures/tink/vectors.json" with { type: "json" };

function hex(value: string): Uint8Array {
  return Uint8Array.from(value.match(/.{2}/g) ?? [], (byte) => parseInt(byte, 16));
}

async function collect(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

describe("Tink AES-GCM-HKDF SHA256 raw profile", () => {
  it("previews an independently produced ZIP through authenticated encrypted ranges", async () => {
    // Python 3.9 stdlib zipfile with fixed 2020-01-01 timestamps. Retained from
    // the archive suite: stored hello world, deflated 80,000 A bytes, a duplicate
    // stored name, and a deflated UTF-8 name. No OPFS writer produced this input.
    const fixture =
      "UEsDBBQAAAAAAAAAIVCFEUoNCwAAAAsAAAAJAAAAZmlyc3QudHh0aGVsbG8gd29ybGRQSwMEFAAAAAgAAAAhUHnPp1NfAAAAgDgBAAkAAABsYXJnZS50eHTtwYEAAAAAwyC2+Usd4ApVAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAADAG1BLAwQUAAAAAAAAACFQG4FHEgkAAAAJAAAACQAAAGZpcnN0LnR4dGR1cGxpY2F0ZVBLAwQUAAAICAAAACFQsymFUwgAAAAGAAAACQAAAGNhZsOpLnR4dEvOT0tLTQUAUEsBAhQDFAAAAAAAAAAhUIURSg0LAAAACwAAAAkAAAAAAAAAAAAAAIABAAAAAGZpcnN0LnR4dFBLAQIUAxQAAAAIAAAAIVB5z6dTXwAAAIA4AQAJAAAAAAAAAAAAAACAATIAAABsYXJnZS50eHRQSwECFAMUAAAAAAAAACFQG4FHEgkAAAAJAAAACQAAAAAAAAAAAAAAgAG4AAAAZmlyc3QudHh0UEsBAhQDFAAACAgAAAAhULMphVMIAAAABgAAAAkAAAAAAAAAAAAAAIAB6AAAAGNhZsOpLnR4dFBLBQYAAAAABAAEANwAAAAXAQAAAAA=";
    const profile = createNativeTink({ segmentBytes: 256 });
    const key = globalThis.crypto.getRandomValues(new Uint8Array(32));
    const aad = new TextEncoder().encode("encrypted-archive-preview-v1");
    const encrypted = await collect(profile.encrypt(createByteSource(decodeBase64(fixture)), key, aad));
    const plaintext = await profile.open(createByteSource(encrypted), key, aad);
    const archive = await openZip(plaintext);
    expect(archive.entries.map((entry) => entry.name)).toEqual(["first.txt", "large.txt", "first.txt", "café.txt"]);
    expect(archive.work.decodedBytes).toBe(0);
    const result = await archive.read(0, { offset: 6, length: 5 });
    expect(new TextDecoder().decode(result.bytes)).toBe("world");
    expect(result.integrity).toBe("checksum-pending");
    expect(plaintext.finalSegmentVerified).toBe(true);
  });
  it("uses native key and associated-data extents before allocation admission", async () => {
    const empty = createByteSource(new Uint8Array());
    const profile = createNativeTink({ maxKeyBytes: 32, maxAssociatedDataBytes: 16 });
    const short = new Uint8Array(1);
    Object.defineProperty(short, "byteLength", { value: 32 });
    expect(() => profile.encrypt(empty, short)).toThrow(TinkError);
    try {
      profile.encrypt(empty, short);
    } catch (reason) {
      expect(reason).toMatchObject({ code: "key" });
    }
    const oversized = new Uint8Array(64);
    Object.defineProperty(oversized, "byteLength", { value: 32 });
    expect(() => profile.encrypt(empty, oversized)).toThrow(TinkError);
    try {
      profile.encrypt(empty, oversized);
    } catch (reason) {
      expect(reason).toMatchObject({ code: "limit" });
    }
    const aad = new Uint8Array(64);
    Object.defineProperty(aad, "byteLength", { value: 0 });
    expect(() => profile.encrypt(empty, new Uint8Array(32), aad)).toThrow(TinkError);
    await expect(profile.open(createByteSource(hex(vectors.vectors[0]!.ciphertext)), new Uint8Array(32), aad)).rejects
      .toMatchObject({ code: "limit" });
  });

  it("ignores shadowed native metadata getters on admitted key, AAD and source ranges", async () => {
    const vector = vectors.vectors[1]!;
    let getters = 0;
    function shadow(bytes: Uint8Array): Uint8Array {
      for (const property of ["byteLength", "byteOffset", "buffer", "length"]) {
        Object.defineProperty(bytes, property, {
          get() {
            getters++;
            throw new Error("Caller metadata must not authorize bytes.");
          },
        });
      }
      return bytes;
    }
    const ciphertext = hex(vector.ciphertext);
    const source = {
      size: ciphertext.length,
      stability: "caller" as const,
      async read(offset: number, length: number) {
        return shadow(ciphertext.slice(offset, offset + length));
      },
    };
    const profile = createNativeTink({ segmentBytes: 64, derivedKeyBytes: 16 });
    const opened = await profile.open(source, shadow(hex(vector.key)), shadow(hex(vector.aad)));
    expect(await opened.read(0, opened.size)).toEqual(hex(vector.plaintext));
    expect(getters).toBe(0);
  });

  it("rejects source extents hidden behind shadowed length properties", async () => {
    const vector = vectors.vectors[1]!;
    const ciphertext = hex(vector.ciphertext);
    const profile = createNativeTink({ segmentBytes: 64, derivedKeyBytes: 16 });
    for (const delta of [-1, 1]) {
      const source = {
        size: ciphertext.length,
        stability: "caller" as const,
        async read(offset: number, length: number) {
          const result = new Uint8Array(length + delta);
          result.set(ciphertext.subarray(offset, offset + Math.min(length, result.length)));
          Object.defineProperty(result, "byteLength", { value: length });
          return result;
        },
      };
      await expect(profile.open(source, hex(vector.key), hex(vector.aad))).rejects.toMatchObject({ code: "format" });
    }
  });
  it("accepts native cross-realm keys and exact source bytes", async () => {
    const vector = vectors.vectors[1]!;
    const ciphertext = hex(vector.ciphertext);
    const key: Uint8Array = runInNewContext(`new Uint8Array(${JSON.stringify([...hex(vector.key)])})`);
    const source = {
      size: ciphertext.length,
      stability: "caller" as const,
      async read(offset: number, length: number): Promise<Uint8Array> {
        return runInNewContext(`new Uint8Array(${JSON.stringify([...ciphertext.slice(offset, offset + length)])})`);
      },
    };
    const profile = createNativeTink({ derivedKeyBytes: 16, segmentBytes: 64 });
    const opened = await profile.open(source, key, hex(vector.aad));
    expect(await opened.read(0, opened.size)).toEqual(hex(vector.plaintext));
  });
  for (const vector of vectors.vectors) {
    it(`matches official Tink Go v2.9.0: ${vector.name}`, async () => {
      expect([16, 32]).toContain(vector.derivedKeyBytes);
      const keyBytes = vector.derivedKeyBytes === 16 ? 16 : 32;
      const ciphertext = hex(vector.ciphertext);
      const plaintext = hex(vector.plaintext);
      const profile = createTink({
        subtle: globalThis.crypto.subtle,
        randomFill: (bytes) => {
          bytes.set(ciphertext.subarray(1, keyBytes + 8));
        },
        segmentBytes: vector.segmentBytes,
        derivedKeyBytes: keyBytes,
      });
      const source = await profile.open(createByteSource(ciphertext), hex(vector.key), hex(vector.aad));
      expect(source.size).toBe(plaintext.length);
      expect(source.finalSegmentVerified).toBe(true);
      expect(await source.read(0, source.size)).toEqual(plaintext);
      expect(await source.verify({ maxCiphertextBytes: ciphertext.length })).toMatchObject({ scope: "whole-envelope" });
      const encrypted = await collect(profile.encrypt(createByteSource(plaintext), hex(vector.key), hex(vector.aad)));
      expect(encrypted).toEqual(ciphertext);
      expect(profile.ciphertextSize(plaintext.length)).toBe(ciphertext.length);
    });
  }

  it("authenticates covering segments without claiming unchecked middle segments", async () => {
    const vector = vectors.vectors.find((entry) => entry.name === "aes128-segment64-length173")!;
    const ciphertext = hex(vector.ciphertext);
    const calls: number[][] = [];
    const native = createByteSource(ciphertext);
    const source = {
      ...native,
      async read(offset: number, length: number) {
        calls.push([offset, length]);
        return await native.read(offset, length);
      },
    };
    const profile = createNativeTink({ derivedKeyBytes: 16, segmentBytes: 64 });
    const opened = await profile.open(source, hex(vector.key), hex(vector.aad));
    expect(calls).toEqual([[0, 24], [256, ciphertext.length - 256]]);
    calls.length = 0;
    const result = await opened.readVerified(25, 2);
    expect(result).toMatchObject({
      scope: "authenticated-segments",
      firstSegment: 1,
      segmentCount: 1,
      ciphertextBytes: 64,
    });
    expect(result.bytes).toEqual(hex(vector.plaintext).slice(25, 27));
    expect(calls).toEqual([[64, 64]]);
    const tampered = ciphertext.slice();
    tampered[128] = tampered[128]! ^ 1;
    const partial = await profile.open(createByteSource(tampered), hex(vector.key), hex(vector.aad));
    expect(await partial.read(0, 2)).toEqual(hex(vector.plaintext).slice(0, 2));
    await expect(partial.verify({ maxCiphertextBytes: tampered.length })).rejects.toMatchObject({
      code: "authentication",
    });
    await expect(partial.read(72, 1)).rejects.toMatchObject({ code: "authentication" });
  });

  it("rejects wrong key, wrong associated data, malformed headers and corrupted final tags before opening", async () => {
    const vector = vectors.vectors[0]!;
    const profile = createNativeTink({ derivedKeyBytes: 16, segmentBytes: 64 });
    const ciphertext = hex(vector.ciphertext);
    await expect(profile.open(createByteSource(ciphertext), new Uint8Array(32), hex(vector.aad))).rejects.toMatchObject(
      { code: "authentication" },
    );
    await expect(profile.open(createByteSource(ciphertext), hex(vector.key), new Uint8Array([1]))).rejects
      .toMatchObject({ code: "authentication" });
    const header = ciphertext.slice();
    header[0] = 40;
    await expect(profile.open(createByteSource(header), hex(vector.key), hex(vector.aad))).rejects.toMatchObject({
      code: "format",
    });
    const tag = ciphertext.slice();
    tag[tag.length - 1] = tag[tag.length - 1]! ^ 1;
    await expect(profile.open(createByteSource(tag), hex(vector.key), hex(vector.aad))).rejects.toMatchObject({
      code: "authentication",
    });
  });

  it("rejects truncation, segment reordering and appended bytes", async () => {
    const vector = vectors.vectors.find((entry) => entry.name === "aes128-segment64-length173")!;
    const ciphertext = hex(vector.ciphertext);
    const profile = createNativeTink({ derivedKeyBytes: 16, segmentBytes: 64 });
    for (let length = 0; length < ciphertext.length; length++) {
      await expect(profile.open(createByteSource(ciphertext.slice(0, length)), hex(vector.key), hex(vector.aad)))
        .rejects.toThrow();
    }
    const appended = new Uint8Array(ciphertext.length + 1);
    appended.set(ciphertext);
    await expect(profile.open(createByteSource(appended), hex(vector.key), hex(vector.aad))).rejects.toThrow();
    const reordered = ciphertext.slice();
    reordered.set(ciphertext.subarray(128, 192), 64);
    reordered.set(ciphertext.subarray(64, 128), 128);
    const opened = await profile.open(createByteSource(reordered), hex(vector.key), hex(vector.aad));
    await expect(opened.read(24, 48)).rejects.toMatchObject({ code: "authentication" });
  });

  it("accepts non-extractable HKDF key capabilities and rejects AES keys", async () => {
    const vector = vectors.vectors[1]!;
    const profile = createNativeTink({ derivedKeyBytes: 16, segmentBytes: 64 });
    for (const usage of ["deriveKey", "deriveBits"] as const) {
      const key = await globalThis.crypto.subtle.importKey("raw", new Uint8Array(hex(vector.key)), "HKDF", false, [
        usage,
      ]);
      const source = await profile.open(createByteSource(hex(vector.ciphertext)), { key, size: 32 }, hex(vector.aad));
      expect(await source.read(0, source.size)).toEqual(hex(vector.plaintext));
    }
    const aes = await globalThis.crypto.subtle.importKey("raw", new Uint8Array(16), "AES-GCM", false, ["decrypt"]);
    await expect(profile.open(createByteSource(hex(vector.ciphertext)), { key: aes, size: 16 }, hex(vector.aad)))
      .rejects.toMatchObject({ code: "key" });
    expect(() => profile.encrypt(createByteSource(new Uint8Array()), new Uint8Array(8))).toThrow(TinkError);
  });

  it("admits work limits before source reads and never treats an identity alone as stability", async () => {
    const vector = vectors.vectors.find((entry) => entry.name === "aes128-segment64-length173")!;
    const native = createByteSource(hex(vector.ciphertext));
    let calls = 0;
    const source = {
      ...native,
      async read(offset: number, length: number) {
        calls++;
        return await native.read(offset, length);
      },
    };
    const profile = createNativeTink({
      derivedKeyBytes: 16,
      segmentBytes: 64,
      maxReadBytes: 100,
      maxSegmentsPerRead: 1,
    });
    const opened = await profile.open(source, hex(vector.key), hex(vector.aad));
    calls = 0;
    await expect(opened.read(0, 101)).rejects.toMatchObject({ code: "limit" });
    await expect(opened.read(20, 10)).rejects.toMatchObject({ code: "limit" });
    await expect(opened.verify({ maxCiphertextBytes: 1 })).rejects.toMatchObject({ code: "limit" });
    expect(calls).toBe(0);
    const unstable = { size: native.size, identity: "just-a-name", read: native.read };
    await expect(profile.open(unstable, hex(vector.key), hex(vector.aad))).rejects.toMatchObject({ code: "stability" });
    const asserted = await profile.open(unstable, hex(vector.key), hex(vector.aad), { assumeStable: true });
    expect(asserted.stability).toBe("caller");
  });

  it("pulls bounded encryption segments and cancels an in-flight source read", async () => {
    const controller = new AbortController();
    let entropy = 0;
    let reads = 0;
    const cancelled = new Error("preview closed");
    const profile = createTink({
      subtle: globalThis.crypto.subtle,
      segmentBytes: 64,
      derivedKeyBytes: 16,
      randomFill(bytes) {
        entropy++;
        globalThis.crypto.getRandomValues(bytes);
      },
    });
    const source = {
      size: 1000,
      stability: "caller" as const,
      async read(_offset: number, length: number, options: { signal?: AbortSignal } = {}) {
        reads++;
        expect(length).toBe(24);
        return await new Promise<Uint8Array>((_resolve, reject) => {
          options.signal?.addEventListener("abort", () => {
            controller.abort();
            reject(options.signal?.reason);
          }, { once: true });
        });
      },
    };
    const stream = profile.encrypt(source, new Uint8Array(32));
    expect(reads).toBe(0);
    expect(entropy).toBe(0);
    const reader = stream.getReader();
    expect((await reader.read()).value?.length).toBe(24);
    expect(entropy).toBe(1);
    const pending = reader.read();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await reader.cancel(cancelled);
    await pending;
    expect(controller.signal.aborted).toBe(true);
    expect(reads).toBe(1);
    reader.releaseLock();
  });
});
