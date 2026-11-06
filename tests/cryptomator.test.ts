import { describe, it } from "node:test";
import { withReleases } from "./close.ts";
import { expect } from "@std/expect";
import { expectBytes } from "./bytes.ts";
import { decodeBase64 } from "@std/encoding/base64";
import { openCryptomator } from "../src/crypto/cryptomator.ts";
import { createArchiveLedger } from "../src/archive/record.ts";
import { openZip } from "../src/archive/zip.ts";
import type { ByteSourceType } from "../src/source.ts";
import fixtures from "./fixtures/cryptomator/independent.json" with { type: "json" };

const encode = (text: string) => new TextEncoder().encode(text);
const key = () => decodeBase64(fixtures.key);
const config = () => encode(fixtures.configuration);
const fixture = (id: string) => {
  const value = fixtures.fixtures.find((item) => item.id === id);
  if (!value) throw new Error(`Missing independent fixture: ${id}`);
  return value;
};
/** Scratch-backed returned views are borrowed even when their physical source is immutable. */
function source(bytes: Uint8Array, calls: { offset: number; length: number }[] = []): ByteSourceType {
  const scratch = new Uint8Array(bytes.length);
  return {
    size: bytes.length,
    stability: "immutable",
    async read(offset, length) {
      calls.push({ offset, length });
      scratch.set(bytes.subarray(offset, offset + length));
      return scratch.subarray(0, length);
    },
  };
}
/** Instrument the explicit trusted capability without replacing native crypto implementations. */
function observe(hook: (name: PropertyKey, args: unknown[]) => unknown): SubtleCrypto {
  const subtle = globalThis.crypto.subtle;
  return new Proxy(subtle, {
    get(target, name) {
      const value = Reflect.get(target, name);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        const replacement = hook(name, args);
        return replacement === undefined ? Reflect.apply(value, target, args) : replacement;
      };
    },
  });
}
/** Authored JWT framing controls are separate from released-library content/name fixtures. */
async function jwt(header: string, payload: string): Promise<Uint8Array> {
  const url = (value: string) =>
    btoa(String.fromCharCode(...encode(value))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const signing = `${url(header)}.${url(payload)}`;
  const hmac = await globalThis.crypto.subtle.importKey("raw", key(), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
  const tag = new Uint8Array(await globalThis.crypto.subtle.sign("HMAC", hmac, encode(signing)));
  return encode(
    `${signing}.${btoa(String.fromCharCode(...tag)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")}`,
  );
}

/** Retire every acquired owner in reverse order and retain a primary failure beside release failures. */
function check(name: string, action: (releases: Array<() => void | PromiseLike<unknown>>) => Promise<void>): void {
  it(name, () => withReleases(action));
}

describe("Cryptomator selected format 8 preview", () => {
  check("matches all reciprocal Java/Python full original bytes and authenticated names", async (releases) => {
    const vault = await openCryptomator(config(), key(), { subtle: globalThis.crypto.subtle });
    releases.push(() => vault[Symbol.asyncDispose]());
    for (const item of fixtures.fixtures) {
      expect((await vault.decryptName(item.encryptedName, item.parent)).name).toBe(item.name);
      expect((await vault.decryptName(item.pythonEncryptedName, item.parent)).name).toBe(item.name);
      for (const encoded of [item.ciphertext, item.pythonCiphertext]) {
        const opened = await vault.open(source(decodeBase64(encoded)));
        releases.push(() => opened[Symbol.asyncDispose]());
        const original = decodeBase64(item.original);
        const read = await opened.readVerified(0, original.length);
        expectBytes(read.bytes, original, item.id);
        expect(read.scope).toBe("covering-chunks-authenticated");
        expect(opened.originalLength).toBe("not-authenticated");
        expect((await opened.verify({ maxCiphertextBytes: decodeBase64(encoded).length })).scope).toBe(
          "all-present-chunks-authenticated",
        );
      }
    }
  });
  check("authenticates only complete covering chunks and preserves cross-boundary selected bytes", async (releases) => {
    const item = fixture("length-100003"), calls: { offset: number; length: number }[] = [];
    const vault = await openCryptomator(config(), key(), { subtle: globalThis.crypto.subtle });
    releases.push(() => vault[Symbol.asyncDispose]());
    const opened = await vault.open(source(decodeBase64(item.ciphertext), calls));
    releases.push(() => opened[Symbol.asyncDispose]());
    calls.length = 0;
    const result = await opened.readVerified(32767, 3);
    expect(result.bytes).toEqual(decodeBase64(item.original).slice(32767, 32770));
    expect(result.chunks).toBe(2);
    expect(result.work).toEqual({ sourceBytes: 65592, requests: 2, decodedBytes: 65536, outputBytes: 3 });
    expect(calls).toEqual([{ offset: 68, length: 32796 }, { offset: 32864, length: 32796 }]);
    calls.length = 0;
    expect(await opened.read(opened.size, 0)).toEqual(new Uint8Array());
    expect(calls).toEqual([]);
  });
  check(
    "does not leak a selected prefix when a covering tag fails and labels unchecked suffixes honestly",
    async (releases) => {
      const item = fixture("length-100003"), bytes = decodeBase64(item.ciphertext);
      bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 1;
      const vault = await openCryptomator(config(), key(), { subtle: globalThis.crypto.subtle });
      releases.push(() => vault[Symbol.asyncDispose]());
      const opened = await vault.open(source(bytes));
      releases.push(() => opened[Symbol.asyncDispose]());
      expect(await opened.read(0, 1)).toEqual(decodeBase64(item.original).slice(0, 1));
      await expect(opened.read(98304, 1)).rejects.toMatchObject({ code: "authentication" });
      await expect(opened.verify({ maxCiphertextBytes: bytes.length })).rejects.toMatchObject({
        code: "authentication",
      });
    },
  );
  check("retains the format's whole-trailing-chunk and independent-name/content boundaries", async (releases) => {
    const item = fixture("length-100003");
    const vault = await openCryptomator(config(), key(), { subtle: globalThis.crypto.subtle });
    releases.push(() => vault[Symbol.asyncDispose]());
    const truncated = decodeBase64(item.ciphertext).slice(0, 68 + 32796);
    const opened = await vault.open(source(truncated));
    releases.push(() => opened[Symbol.asyncDispose]());
    expect(opened.size).toBe(32768);
    expect(await opened.read(0, opened.size)).toEqual(decodeBase64(item.original).slice(0, 32768));
    expect((await opened.verify({ maxCiphertextBytes: truncated.length })).scope).toBe(
      "all-present-chunks-authenticated",
    );
    // Both names authenticate independently in the same root directory; neither authenticates this content mapping.
    const other = fixture("nested-zip");
    expect((await vault.decryptName(other.encryptedName, "")).name).toBe("archive.zip");
    expect((await vault.decryptName(item.encryptedName, "")).name).toBe("report.bin");
  });
  check(
    "rejects wrong parent, altered SIV, wrong config key, bad header, reordering and partial tails",
    async (releases) => {
      const item = fixture("length-100003"), wrong = key();
      wrong[0] = wrong[0]! ^ 1;
      await expect(openCryptomator(config(), wrong, { subtle: globalThis.crypto.subtle })).rejects.toMatchObject({
        code: "authentication",
      });
      const vault = await openCryptomator(config(), key(), { subtle: globalThis.crypto.subtle });
      releases.push(() => vault[Symbol.asyncDispose]());
      await expect(vault.decryptName(item.encryptedName, "wrong")).rejects.toMatchObject({ code: "authentication" });
      const altered = (item.encryptedName[0] === "A" ? "B" : "A") + item.encryptedName.slice(1);
      await expect(vault.decryptName(altered, item.parent)).rejects.toMatchObject({ code: "authentication" });
      const badHeader = decodeBase64(item.ciphertext);
      badHeader[67] = badHeader[67]! ^ 1;
      await expect(vault.open(source(badHeader))).rejects.toMatchObject({ code: "authentication" });
      const swapped = decodeBase64(item.ciphertext), first = swapped.slice(68, 32864);
      swapped.copyWithin(68, 32864, 65660);
      swapped.set(first, 32864);
      const opened = await vault.open(source(swapped));
      releases.push(() => opened[Symbol.asyncDispose]());
      await expect(opened.read(0, 1)).rejects.toMatchObject({ code: "authentication" });
      await expect(vault.open(source(swapped.slice(0, 69)))).rejects.toMatchObject({ code: "profile" });
    },
  );
  check(
    "applies the selected-name cap independently of the authenticated vault shortening threshold",
    async (releases) => {
      const vault = await openCryptomator(config(), key(), { subtle: globalThis.crypto.subtle, maxNameBytes: 64 });
      releases.push(() => vault[Symbol.asyncDispose]());
      expect(vault.shorteningThreshold).toBe(220);
      const short = fixture("name-1"), long = fixture("name-33");
      expect((await vault.decryptName(short.encryptedName, short.parent)).name).toBe(short.name);
      await expect(vault.decryptName(long.encryptedName, long.parent)).rejects.toMatchObject({ code: "profile" });
    },
  );
  check("uses a separate nonextractable equality key and native sign/verify for SIV evidence", async (releases) => {
    const calls: { name: PropertyKey; args: unknown[] }[] = [];
    const vault = await openCryptomator(config(), key(), {
      subtle: observe((name, args) => {
        calls.push({ name, args });
      }),
    });
    releases.push(() => vault[Symbol.asyncDispose]());
    const generated = calls.filter((item) => item.name === "generateKey");
    expect(generated).toHaveLength(1);
    expect(generated[0]!.args[1]).toBe(false);
    calls.length = 0;
    await vault.decryptName(fixture("unicode").encryptedName, fixture("unicode").parent);
    expect(calls.filter((item) => item.name === "sign")).toHaveLength(1);
    expect(calls.filter((item) => item.name === "verify")).toHaveLength(1);
  });
  check(
    "preserves literal U+FEFF names while rejecting BOM configuration framing and JSON ambiguity",
    async (releases) => {
      const item = fixture("bom-name");
      const vault = await openCryptomator(config(), key(), { subtle: globalThis.crypto.subtle });
      releases.push(() => vault[Symbol.asyncDispose]());
      expect((await vault.decryptName(item.encryptedName, "")).name).toBe("\ufeffliteral.txt");
      await expect(
        openCryptomator(encode("\ufeff" + fixtures.configuration), key(), { subtle: globalThis.crypto.subtle }),
      ).rejects.toMatchObject({ code: "format" });
      const payload = '{"format":8,"cipherCombo":"SIV_GCM","shorteningThreshold":220}';
      for (const header of ['\ufeff{"typ":"JWT","alg":"HS256"}', '{"typ":"JWT","alg":"HS256","alg":"none"}']) {
        await expect(openCryptomator(await jwt(header, payload), key(), { subtle: globalThis.crypto.subtle })).rejects
          .toMatchObject({ code: "format" });
      }
    },
  );
  check(
    "admits external configuration and read budgets before any native dispatch or physical I/O",
    async (releases) => {
      let nativeCalls = 0;
      const subtle = observe(() => {
        nativeCalls++;
      });
      await expect(openCryptomator(config(), key(), { subtle, ledger: createArchiveLedger({ maxDecodedBytes: 0 }) }))
        .rejects.toMatchObject({ code: "budget-exceeded" });
      expect(nativeCalls).toBe(0);
      const item = fixture("length-100003"), calls: { offset: number; length: number }[] = [];
      const ledger = createArchiveLedger({ maxSourceBytes: 68 });
      const vault = await openCryptomator(config(), key(), { subtle, ledger });
      releases.push(() => vault[Symbol.asyncDispose]());
      const opened = await vault.open(source(decodeBase64(item.ciphertext), calls), { ledger });
      releases.push(() => opened[Symbol.asyncDispose]());
      expect(ledger.inspect().sourceBytes).toBe(68);
      calls.length = 0;
      await expect(opened.readVerified(0, 1, { ledger })).rejects.toMatchObject({ code: "budget-exceeded" });
      expect(calls).toHaveLength(0);
      await expect(opened.readVerified(0, 1, { maxOutputBytes: 0 })).rejects.toMatchObject({ code: "budget-exceeded" });
      expect(calls).toHaveLength(0);
    },
  );
  check("rejects signed rounded numeric spellings before treating them as supported integers", async (_releases) => {
    for (
      const payload of [
        '{"format":8.0000000000000001,"cipherCombo":"SIV_GCM","shorteningThreshold":220}',
        '{"format":8,"cipherCombo":"SIV_GCM","shorteningThreshold":220.0000000000000001}',
        '{"format":8e0,"cipherCombo":"SIV_GCM","shorteningThreshold":220}',
      ]
    ) {
      const signed = await jwt('{"typ":"JWT","alg":"HS256"}', payload);
      await expect(openCryptomator(signed, key(), { subtle: globalThis.crypto.subtle })).rejects.toMatchObject({
        code: "format",
      });
    }
  });
  check(
    "observes synchronous ledger abort before copying/dispatching configuration or reading encrypted extents",
    async (releases) => {
      const reason = new Error("ledger owner aborts during admission");
      let count = 0;
      const controller = new AbortController(), base = createArchiveLedger();
      const ledger = {
        reserve(kind: Parameters<typeof base.reserve>[0], size: number) {
          base.reserve(kind, size);
          controller.abort(reason);
        },
        inspect: base.inspect,
      };
      await expect(openCryptomator(config(), key(), {
        subtle: observe(() => {
          count++;
        }),
        signal: controller.signal,
        ledger,
      })).rejects.toBe(reason);
      expect(count).toBe(0);
      const vault = await openCryptomator(config(), key(), { subtle: globalThis.crypto.subtle });
      releases.push(() => vault[Symbol.asyncDispose]());
      const raw = decodeBase64(fixture("length-100003").ciphertext), calls: { offset: number; length: number }[] = [];
      const headerAbort = new AbortController();
      const headerBase = createArchiveLedger();
      const headerLedger = {
        reserve(kind: Parameters<typeof base.reserve>[0], size: number) {
          headerBase.reserve(kind, size);
          headerAbort.abort(reason);
        },
        inspect: headerBase.inspect,
      };
      await expect(vault.open(source(raw, calls), { signal: headerAbort.signal, ledger: headerLedger })).rejects.toBe(
        reason,
      );
      expect(calls).toHaveLength(0);
      const opened = await vault.open(source(raw, calls));
      releases.push(() => opened[Symbol.asyncDispose]());
      calls.length = 0;
      const readAbort = new AbortController(), readBase = createArchiveLedger();
      const readLedger = {
        reserve(kind: Parameters<typeof base.reserve>[0], size: number) {
          readBase.reserve(kind, size);
          readAbort.abort(reason);
        },
        inspect: readBase.inspect,
      };
      await expect(opened.readVerified(0, 1, { signal: readAbort.signal, ledger: readLedger })).rejects.toBe(reason);
      expect(calls).toHaveLength(0);
      count = 0;
      const nameAbort = new AbortController(), nameBase = createArchiveLedger();
      const nameLedger = {
        reserve(kind: Parameters<typeof base.reserve>[0], size: number) {
          nameBase.reserve(kind, size);
          nameAbort.abort(reason);
        },
        inspect: nameBase.inspect,
      };
      const named = await openCryptomator(config(), key(), {
        subtle: observe(() => {
          count++;
        }),
      });
      releases.push(() => named[Symbol.asyncDispose]());
      count = 0;
      await expect(named.decryptName(fixture("unicode").encryptedName, fixture("unicode").parent, {
        signal: nameAbort.signal,
        ledger: nameLedger,
      })).rejects.toBe(reason);
      expect(count).toBe(0);
    },
  );
  check(
    "includes the header in whole-file ciphertext admission, including header-only empty files",
    async (releases) => {
      const vault = await openCryptomator(config(), key(), { subtle: globalThis.crypto.subtle });
      releases.push(() => vault[Symbol.asyncDispose]());
      for (const id of ["length-0", "length-100003"]) {
        const raw = decodeBase64(fixture(id).ciphertext), calls: { offset: number; length: number }[] = [];
        const opened = await vault.open(source(raw, calls));
        releases.push(() => opened[Symbol.asyncDispose]());
        calls.length = 0;
        await expect(opened.verify({ maxCiphertextBytes: raw.length - 1 })).rejects.toMatchObject({ code: "limit" });
        expect(calls).toHaveLength(0);
        const verified = await opened.verify({ maxCiphertextBytes: raw.length });
        expect(verified.scope).toBe("all-present-chunks-authenticated");
        if (id === "length-0") expect(calls).toHaveLength(0);
      }
    },
  );
  check(
    "pre-admits operation-owned native credits before body I/O and cannot lend name credits to a concurrent read",
    async (releases) => {
      const raw = decodeBase64(fixture("length-1").ciphertext), calls: { offset: number; length: number }[] = [];
      const vault = await openCryptomator(config(), key(), { subtle: globalThis.crypto.subtle, maxNativeCalls: 8 });
      releases.push(() => vault[Symbol.asyncDispose]());
      const opened = await vault.open(source(raw, calls));
      releases.push(() => opened[Symbol.asyncDispose]());
      calls.length = 0;
      await expect(opened.read(0, 1)).rejects.toMatchObject({ code: "limit" });
      expect(calls).toHaveLength(0);
      const other = await openCryptomator(config(), key(), { subtle: globalThis.crypto.subtle, maxNativeCalls: 17 });
      releases.push(() => other[Symbol.asyncDispose]());
      const otherSource = await other.open(source(raw, calls));
      releases.push(() => otherSource[Symbol.asyncDispose]());
      calls.length = 0;
      const item = fixture("unicode");
      const name = other.decryptName(item.encryptedName, item.parent);
      await expect(otherSource.read(0, 1)).rejects.toMatchObject({ code: "limit" });
      expect(calls).toHaveLength(0);
      expect((await name).name).toBe(item.name);
    },
  );
  check("bounds live key slots and concurrency, then releases source slots on disposal", async (releases) => {
    const vault = await openCryptomator(config(), key(), {
      subtle: globalThis.crypto.subtle,
      maxOpenFiles: 1,
      maxConcurrent: 1,
    });
    releases.push(() => vault[Symbol.asyncDispose]());
    const raw = decodeBase64(fixture("length-1").ciphertext);
    const opened = await vault.open(source(raw));
    await expect(vault.open(source(raw))).rejects.toMatchObject({ code: "limit" });
    await opened[Symbol.asyncDispose]();
    const again = await vault.open(source(raw));
    releases.push(() => again[Symbol.asyncDispose]());
    expect(await again.read(0, 1)).toEqual(decodeBase64(fixture("length-1").original));
    const pending = again.read(0, 1);
    await expect(again.read(0, 1)).rejects.toMatchObject({ code: "limit" });
    await pending;
  });
  check(
    "registers active work before reentrant provider disposal and retains independent provider failure",
    async (releases) => {
      const reason = new Error("provider fails after reentrant close");
      const vault = await openCryptomator(config(), key(), { subtle: globalThis.crypto.subtle });
      releases.push(() => vault[Symbol.asyncDispose]());
      let closing: PromiseLike<void> | undefined;
      const raw = decodeBase64(fixture("length-1").ciphertext);
      const input: ByteSourceType = {
        size: raw.length,
        stability: "caller",
        async read() {
          closing = vault[Symbol.asyncDispose]();
          throw reason;
        },
      };
      await expect(vault.open(input)).rejects.toBe(reason);
      await closing;
      await expect(vault.open(source(raw))).rejects.toMatchObject({ code: "closed" });
    },
  );
  check(
    "captures caller bytes, capabilities, descriptors and opening limits before asynchronous mutation",
    async (releases) => {
      const configBytes = config(), raw = key(), subtle = observe(() => {});
      const pending = openCryptomator(configBytes, raw, { subtle, maxOutputBytes: 8 });
      configBytes.fill(0);
      raw.fill(0);
      const vault = await pending;
      releases.push(() => vault[Symbol.asyncDispose]());
      const item = fixture("length-100003"), input = source(decodeBase64(item.ciphertext));
      const options = { maxOutputBytes: 3 };
      const file = vault.open(input, options);
      options.maxOutputBytes = 100000;
      input.read = () => Promise.reject(new Error("replacement must not run"));
      const opened = await file;
      releases.push(() => opened[Symbol.asyncDispose]());
      expect(await opened.read(0, 3)).toEqual(decodeBase64(item.original).slice(0, 3));
      await expect(opened.read(0, 4)).rejects.toMatchObject({ code: "budget-exceeded" });
    },
  );
  check(
    "retains parent abort and native/provider failures without reporting them as bad ciphertext",
    async (releases) => {
      const sentinel = new Error("independent native provider failure");
      let rejectDecrypt = false;
      const vault = await openCryptomator(config(), key(), {
        subtle: observe((name) => name === "decrypt" && rejectDecrypt ? Promise.reject(sentinel) : undefined),
      });
      releases.push(() => vault[Symbol.asyncDispose]());
      rejectDecrypt = true;
      await expect(vault.open(source(decodeBase64(fixture("length-1").ciphertext)))).rejects.toBe(sentinel);
      const controller = new AbortController();
      const other = await openCryptomator(config(), key(), {
        subtle: globalThis.crypto.subtle,
        signal: controller.signal,
      });
      releases.push(() => other[Symbol.asyncDispose]());
      const opened = await other.open(source(decodeBase64(fixture("length-1").ciphertext)));
      releases.push(() => opened[Symbol.asyncDispose]());
      controller.abort(sentinel);
      await expect(opened.read(0, 1)).rejects.toBe(sentinel);
      await expect(opened.read(0, 0)).rejects.toBe(sentinel);
    },
  );
  check(
    "joins in-flight native decryption before cancellation/disposal and does not return observed-abort plaintext",
    async (releases) => {
      const controller = new AbortController(), sentinel = new Error("stop after native settlement");
      let abortDecrypt = false;
      const subtle = observe((name, args) => {
        if (name !== "decrypt" || !abortDecrypt) return undefined;
        return Reflect.apply(globalThis.crypto.subtle.decrypt, globalThis.crypto.subtle, args).then(
          (result: ArrayBuffer) => {
            controller.abort(sentinel);
            return result;
          },
        );
      });
      const vault = await openCryptomator(config(), key(), { subtle });
      releases.push(() => vault[Symbol.asyncDispose]());
      const opened = await vault.open(source(decodeBase64(fixture("length-1").ciphertext)));
      releases.push(() => opened[Symbol.asyncDispose]());
      abortDecrypt = true;
      await expect(opened.readVerified(0, 1, { signal: controller.signal })).rejects.toBe(sentinel);
      await opened[Symbol.asyncDispose]();
      await expect(opened.read(0, 0)).rejects.toMatchObject({ code: "closed" });
    },
  );
  check(
    "opens a genuine encrypted ZIP as a plaintext source without reading the whole unrelated file",
    async (releases) => {
      const item = fixture("nested-zip"), calls: { offset: number; length: number }[] = [];
      const vault = await openCryptomator(config(), key(), { subtle: globalThis.crypto.subtle });
      releases.push(() => vault[Symbol.asyncDispose]());
      const opened = await vault.open(source(decodeBase64(item.ciphertext), calls));
      releases.push(() => opened[Symbol.asyncDispose]());
      const zip = await openZip(opened);
      const entry = zip.entries.find((item) => item.name === "selected.txt");
      expect(entry).toBeDefined();
      const preview = await zip.read(entry!.id);
      expect(new TextDecoder().decode(preview.bytes)).toBe("authenticated nested archive preview\n");
      expect(calls.reduce((sum, item) => sum + item.length, 0)).toBeLessThan(200000);
      // ZIP must inspect its bounded EOF window; covering GCM chunks can include
      // neighboring unrelated bytes, but no unrelated prefix chunks are needed.
      const firstTailChunk = Math.floor(Math.max(0, opened.size - 65557) / 32768);
      expect(calls.every((item) => item.offset === 0 || item.offset >= 68 + firstTailChunk * 32796)).toBe(true);
    },
  );
});
