import { describe, it } from "node:test";
import { createCipheriv, createDecipheriv } from "node:crypto";
import { env, versions } from "node:process";
import { createDenoAgeOracle } from "./age-oracle.ts";
import { expect } from "@std/expect";
import { decodeBase64, encodeBase64 } from "@std/encoding/base64";
import { openZip } from "../src/archive/zip.ts";
import zipFixture from "./fixtures/arfs/zip.json" with { type: "json" };
import { AgeError, createArchiveLedger, openAge } from "../src/crypto/age.ts";
import type { AgeAeadType, AgeOpenOptionsType } from "../src/crypto/age.ts";
import { createNodeAgeAead } from "../src/crypto/age-node.ts";
import type { ByteSourceType } from "../src/source.ts";
import type { AgeOpenedType } from "../src/crypto/age.ts";
import native from "./fixtures/age/independent.json" with { type: "json" };
import cctv from "./fixtures/age/cctv.json" with { type: "json" };

const subtle = globalThis.crypto.subtle;
const encode = (text: string) => new TextEncoder().encode(text);
const fileKey = () => Uint8Array.from({ length: 16 }, (_, i) => i + 1);
const nativeAead = createNodeAgeAead({ createDecipheriv });
// This is explicit test injection, not a production capability fallback. The
// Bun CI job declares Deno through Mise; an absent/wrong executable fails tests.
const oracle = versions.bun === undefined ? undefined : createDenoAgeOracle(env.OPFS_AGE_TEST_DENO ?? "deno");
const aead: AgeAeadType = oracle ?? nativeAead;
function options(extra: Partial<AgeOpenOptionsType> = {}): AgeOpenOptionsType {
  return { profile: "age-v1-file-key", fileKey: fileKey(), subtle, aead, ...extra };
}
function source(wire: Uint8Array, read?: ByteSourceType["read"]): ByteSourceType {
  return {
    size: wire.length,
    stability: "caller",
    identity: "authored-age",
    read: read ?? (async (offset, length) => wire.slice(offset, offset + length)),
  };
}
/** Authored primary grammar plus native encryption, not a native age CLI fixture. */
async function envelope(plain: Uint8Array, stanza = "-> test\n\n"): Promise<{ wire: Uint8Array; header: number }> {
  const ikm = await subtle.importKey("raw", fileKey(), "HKDF", false, ["deriveBits"]);
  const nonce = Uint8Array.from({ length: 16 }, (_, i) => i + 30);
  async function derive(salt: Uint8Array<ArrayBuffer>, label: string): Promise<Uint8Array<ArrayBuffer>> {
    return new Uint8Array(
      await subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info: encode(label) }, ikm, 256),
    );
  }
  const prefix = "age-encryption.org/v1\n" + stanza + "---";
  const headerKey = await subtle.importKey(
    "raw",
    await derive(new Uint8Array(), "header"),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = encodeBase64(new Uint8Array(await subtle.sign("HMAC", headerKey, encode(prefix)))).replace(/=+$/, "");
  const header = encode(prefix + " " + mac + "\n");
  const key = await derive(nonce, "payload");
  const pieces: Uint8Array[] = [header, nonce];
  const count = Math.max(1, Math.ceil(plain.length / 65536));
  for (let i = 0; i < count; i++) {
    const iv = new Uint8Array(12);
    let counter = BigInt(i);
    for (let j = 10; j >= 0; j--) {
      iv[j] = Number(counter & 255n);
      counter >>= 8n;
    }
    iv[11] = i === count - 1 ? 1 : 0;
    const part = new Uint8Array(plain.subarray(i * 65536, (i + 1) * 65536));
    if (oracle) pieces.push(await oracle.encrypt(key, iv, part));
    else {
      const cipher = createCipheriv("chacha20-poly1305", key, iv, { authTagLength: 16 });
      pieces.push(cipher.update(part), cipher.final(), cipher.getAuthTag());
    }
  }
  const wire = new Uint8Array(pieces.reduce((n, piece) => n + piece.length, 0));
  let at = 0;
  for (const piece of pieces) {
    wire.set(piece, at);
    at += piece.length;
  }
  return { wire, header: header.length };
}
function original(length: number): Uint8Array<ArrayBuffer> {
  return Uint8Array.from({ length }, (_, i) => (i * 31 + 7) & 255);
}

describe("age caller-unlocked payload preview", () => {
  for (const length of [0, 1, 65535, 65536, 65537, 131089]) {
    it(`authenticates exact ${length}-byte boundary and selected range`, async () => {
      const plain = original(length), { wire } = await envelope(plain);
      const owner = await openAge(source(wire), options());
      try {
        expect(owner.size).toBe(length);
        expect(owner.integrity).toBe("header-and-final-chunk-authenticated");
        const offset = Math.max(0, length - 37), size = length - offset;
        const plan = owner.plan(offset, size);
        const selected = await owner.read(offset, size);
        expect(selected.bytes).toEqual(plain.slice(offset));
        expect(selected.work.sourceBytes).toBe(plan.sourceBytes);
        expect(selected.work.requests).toBe(plan.requests);
        expect(selected.work.decodedBytes).toBe(plan.decodedBytes);
        expect(selected.integrity).toBe("selected-chunks-authenticated");
        expect((await owner.verify()).integrity).toBe("all-chunks-authenticated");
        expect((await owner.read(length, 0)).chunkCount).toBe(0);
      } finally {
        await owner.dispose();
      }
    });
  }
  it("composes authenticated selected ranges with an independent Python ZIP fixture", async () => {
    const { wire } = await envelope(decodeBase64(zipFixture.wireBase64));
    const owner = await openAge(source(wire), options());
    try {
      const zip = await openZip(owner.source);
      const member = zip.entries.find((entry) => entry.name === zipFixture.name);
      expect(member).toBeDefined();
      expect((await zip.read(member!.id)).bytes).toEqual(decodeBase64(zipFixture.originalBase64));
    } finally {
      await owner.dispose();
    }
  });
  it("refuses CR framing and noncanonical recipient Base64 before crypto", async () => {
    for (const stanza of ["-> test\r\n\n", "-> test\nAB\n", "-> test  extra\n\n"]) {
      const { wire } = await envelope(original(1), stanza);
      await expect(openAge(source(wire), options())).rejects.toThrow();
    }
  });
  it("leaves unselected intermediate corruption pending while refusing selected or whole verification", async () => {
    const plain = original(3 * 65536 + 9), { wire, header } = await envelope(plain);
    wire[header + 16 + 65552 + 10] = wire[header + 16 + 65552 + 10]! ^ 1;
    const owner = await openAge(source(wire), options());
    try {
      expect((await owner.read(0, 13)).bytes).toEqual(plain.slice(0, 13));
      await expect(owner.read(65536, 1)).rejects.toThrow("authentication");
      await expect(owner.verify()).rejects.toThrow("authentication");
    } finally {
      await owner.dispose();
    }
  });
  it("refuses wrong keys, final tags, truncated and trailing envelopes", async () => {
    const { wire } = await envelope(original(31));
    const wrong = fileKey();
    wrong[0] = wrong[0]! ^ 1;
    await expect(openAge(source(wire), options({ fileKey: wrong }))).rejects.toThrow("authentication");
    const tampered = wire.slice();
    tampered[tampered.length - 1] = tampered[tampered.length - 1]! ^ 1;
    for (const invalid of [tampered, wire.slice(0, -1), new Uint8Array([...wire, 0])]) {
      await expect(openAge(source(invalid), options())).rejects.toThrow();
    }
  });
  it("refuses many or overlong stanza tokens before token materialization", async () => {
    const many = await envelope(original(1), "-> test " + Array.from({ length: 1000 }, () => "x").join(" ") + "\n\n");
    const long = await envelope(original(1), "-> " + "x".repeat(1025) + "\n\n");
    let calls = 0;
    const provider: AgeAeadType = {
      async decrypt(...args) {
        calls++;
        return await aead.decrypt(...args);
      },
    };
    await expect(openAge(source(many.wire), options({ maxTokens: 4, aead: provider }))).rejects.toThrow(
      "stanza tokens",
    );
    await expect(openAge(source(long.wire), options({ maxTokenBytes: 1024, aead: provider }))).rejects.toThrow(
      "token bytes",
    );
    expect(calls).toBe(0);
  });
  it("copies the file key before foreign option getters and ignores unrelated getters", async () => {
    const { wire } = await envelope(original(10)), key = fileKey();
    const supplied = options({ fileKey: key });
    Object.defineProperty(supplied, "maxHeaderBytes", {
      get() {
        key.fill(0);
        return 65536;
      },
    });
    Object.defineProperty(supplied, "unrelated", {
      get() {
        throw new Error("must not run");
      },
    });
    const owner = await openAge(source(wire), supplied);
    try {
      expect((await owner.read(0, 10)).bytes).toEqual(original(10));
    } finally {
      await owner.dispose();
    }
  });
  it("does not publish the crypto provider's retained plaintext storage", async () => {
    const { wire } = await envelope(original(19));
    let retained: Uint8Array | undefined;
    const provider: AgeAeadType = {
      async decrypt(...args) {
        retained = await aead.decrypt(...args);
        return retained;
      },
    };
    const owner = await openAge(source(wire), options({ aead: provider }));
    try {
      const result = await owner.read(0, 19);
      retained!.fill(0);
      expect(result.bytes).toEqual(original(19));
    } finally {
      await owner.dispose();
    }
  });
  it("reserves decoded and external request limits before payload I/O", async () => {
    const { wire } = await envelope(original(20));
    let reads = 0;
    const input = source(wire, async (offset, length) => {
      reads++;
      return wire.slice(offset, offset + length);
    });
    await expect(openAge(input, options({ maxDecodedBytes: 0 }))).rejects.toThrow();
    expect(reads).toBe(0);
    const ledger = createArchiveLedger({ maxRequests: 100 });
    const owner = await openAge(input, options({ ledger }));
    try {
      ledger.reserve("requests", 100 - ledger.inspect().requests);
      const before = reads;
      await expect(owner.read(0, 1)).rejects.toThrow();
      expect(reads).toBe(before);
    } finally {
      await owner.dispose();
    }
  });
  it("retains opening abort authority when the child supplies a fresh signal", async () => {
    const controller = new AbortController(), { wire } = await envelope(original(1));
    const owner = await openAge(source(wire), options({ signal: controller.signal }));
    controller.abort(new Error("opening stop"));
    await expect(owner.read(0, 1, { signal: new AbortController().signal })).rejects.toThrow("opening stop");
    expect(() => owner.source).toThrow("opening stop");
    await owner.closed;
  });
  it("checks an abort triggered by the final foreign reservation before source I/O", async () => {
    const { wire } = await envelope(original(10));
    const controller = new AbortController();
    let reads = 0, armed = false;
    const local = createArchiveLedger({ maxRequests: 100 });
    const ledger = {
      inspect: () => local.inspect(),
      reserve(kind: Parameters<typeof local.reserve>[0], count: number) {
        local.reserve(kind, count);
        if (armed && kind === "requests") controller.abort(new Error("quota abort"));
      },
    };
    const owner = await openAge(
      source(wire, async (offset, length) => {
        reads++;
        return wire.slice(offset, offset + length);
      }),
      options({ ledger, signal: controller.signal }),
    );
    const nested = owner.source;
    armed = true;
    const before = reads;
    await expect(nested.read(0, 1, { signal: new AbortController().signal })).rejects.toThrow("quota abort");
    expect(reads).toBe(before);
    await owner.closed;
  });
  it("snapshots the source method and copies borrowed reusable scratch", async () => {
    const { wire } = await envelope(original(65537));
    const scratch = new Uint8Array(wire.length);
    const input = source(wire, async (offset, length) => {
      scratch.fill(0);
      scratch.set(wire.subarray(offset, offset + length));
      return scratch.subarray(0, length);
    });
    const owner = await openAge(input, options());
    Object.defineProperty(input, "read", {
      value() {
        throw new Error("replacement must not run");
      },
    });
    Object.defineProperty(input, "size", { value: 0 });
    try {
      expect((await owner.read(65530, 7)).bytes).toEqual(original(65537).slice(65530));
    } finally {
      await owner.dispose();
    }
  });
  it("joins a late provider rejection after prompt cancellation and rejects overlap", async () => {
    const { wire } = await envelope(original(5));
    const gate = Promise.withResolvers<Uint8Array>();
    const entered = Promise.withResolvers<void>();
    let gated = false;
    const provider: AgeAeadType = {
      async decrypt(...args) {
        if (!gated) return await aead.decrypt(...args);
        entered.resolve();
        return await gate.promise;
      },
    };
    const owner = await openAge(source(wire), options({ aead: provider }));
    gated = true;
    const pending = owner.read(0, 5);
    await entered.promise;
    await expect(owner.read(0, 1)).rejects.toThrow("one operation");
    owner.cancel();
    const failure = new Error("late provider failure");
    gate.reject(failure);
    await expect(pending).rejects.toBe(failure);
    await expect(owner.closed).rejects.toBe(failure);
  });
  it("permits a borrowed callback to cancel promptly without publishing bytes", async () => {
    const { wire } = await envelope(original(5));
    const hook: { cancel?: () => void } = {};
    const provider: AgeAeadType = {
      async decrypt(...args) {
        const result = await aead.decrypt(...args);
        hook.cancel?.();
        return result;
      },
    };
    const owner = await openAge(source(wire), options({ aead: provider }));
    hook.cancel = () => owner.cancel(new Error("reentrant stop"));
    await expect(owner.read(0, 5)).rejects.toThrow("reentrant stop");
    await owner.closed;
  });
  it("admits native key extents rather than shadowed byteLength metadata", async () => {
    const { wire } = await envelope(original(1));
    const short = new Uint8Array(1);
    Object.defineProperty(short, "byteLength", {
      get() {
        return 16;
      },
    });
    await expect(openAge(source(wire), options({ fileKey: short }))).rejects.toThrow("exactly 16");
  });
  it("retains arbitrary provider failures unchanged, including undefined", async () => {
    const { wire } = await envelope(original(1));
    for (const reason of [undefined, new Error("provider unavailable"), Object.freeze({ code: "provider-fault" })]) {
      const failures: unknown[] = [];
      const provider: AgeAeadType = {
        async decrypt() {
          throw reason;
        },
      };
      try {
        await openAge(source(wire), options({ aead: provider }));
      } catch (error) {
        failures.push(error);
      }
      expect(failures.length).toBe(1);
      expect(failures[0]).toBe(reason);
    }
  });
  it("retains native cipher construction faults rather than inventing authentication", async () => {
    const reason = new Error("cipher unavailable");
    const provider = createNodeAgeAead({
      createDecipheriv() {
        throw reason;
      },
    });
    const failures: unknown[] = [];
    try {
      await provider.decrypt(new Uint8Array(32), new Uint8Array(12), new Uint8Array(16));
    } catch (error) {
      failures.push(error);
    }
    expect(failures.length).toBe(1);
    expect(failures[0]).toBe(reason);
  });
  it("identifies actual native cipher availability separately from portable fixture coverage", async () => {
    const probeFailures: unknown[] = [];
    try {
      createCipheriv("chacha20-poly1305", new Uint8Array(32), new Uint8Array(12), { authTagLength: 16 });
    } catch (reason) {
      probeFailures.push(reason);
    }
    if (probeFailures.length) {
      // This exact observed native code is the only accepted unavailable case.
      // Any unrelated failure remains a failed test, never a capability skip.
      expect(versions.bun).toBeDefined();
      const reason = probeFailures[0];
      expect(reason !== null && typeof reason === "object" && "code" in reason ? reason.code : undefined).toBe(
        "ERR_CRYPTO_UNKNOWN_CIPHER",
      );
      const failures: unknown[] = [];
      try {
        await nativeAead.decrypt(new Uint8Array(32), new Uint8Array(12), new Uint8Array(16));
      } catch (error) {
        failures.push(error);
      }
      expect(failures.length).toBe(1);
      const failure = failures[0];
      expect(failure !== null && typeof failure === "object" && "code" in failure ? failure.code : undefined).toBe(
        "ERR_CRYPTO_UNKNOWN_CIPHER",
      );
    } else {
      const item = native.records.find((item) => item.name === "bytes-65537")!;
      const unlocked = Uint8Array.from(item.fileKeyHex.match(/../g)!, (byte) => Number.parseInt(byte, 16));
      const owner = await openAge(
        source(decodeBase64(item.wireBase64)),
        options({ fileKey: unlocked, aead: nativeAead }),
      );
      try {
        expect((await owner.read(0, owner.size)).bytes).toEqual(decodeBase64(item.originalBase64));
      } finally {
        await owner.dispose();
      }
    }
  });
  it("native adapter withholds tentative plaintext when final authentication fails", async () => {
    let updated = false;
    const provider = createNodeAgeAead({
      createDecipheriv() {
        return {
          setAuthTag() {},
          update() {
            updated = true;
            return encode("secret");
          },
          final() {
            throw new Error("bad tag");
          },
        };
      },
    });
    const failures: unknown[] = [];
    try {
      await provider.decrypt(new Uint8Array(32), new Uint8Array(12), new Uint8Array(22));
    } catch (reason) {
      failures.push(reason);
    }
    expect(failures.length).toBe(1);
    expect(failures[0]).toBeInstanceOf(AgeError);
    expect((failures[0] as AgeError).code).toBe("authentication");
    expect((failures[0] as AgeError).message).not.toContain("bad tag");
    expect(Object.hasOwn(failures[0] as object, "cause")).toBe(false);
    expect(updated).toBe(true);
  });
});

/** Independent CLI ciphertext and upstream expected outcomes, never candidate round trips. */
describe("age native and immutable CCTV evidence", () => {
  it("covers every admitted upstream success and negative expectation", () => {
    expect(cctv.vectors.length).toBe(50);
    expect(native.records.length).toBe(8);
    expect(native.corpus.map((item) => item.name).sort()).toEqual(
      cctv.vectors.filter((item) => item.expected === "success").map((item) => item.name).sort(),
    );
    expect(cctv.vectors.filter((item) => item.expected !== "success").length).toBe(42);
  });
  for (const item of [...native.records, ...native.corpus]) {
    it(`reads complete native oracle ${item.name}`, async () => {
      const wire = decodeBase64(item.wireBase64), plain = decodeBase64(item.originalBase64);
      const key = Uint8Array.from(item.fileKeyHex.match(/../g)!, (byte) => Number.parseInt(byte, 16));
      const owner = await openAge(source(wire), options({ fileKey: key }));
      try {
        expect(owner.size).toBe(plain.length);
        expect((await owner.read(0, plain.length)).bytes).toEqual(plain);
        const offset = Math.max(0, plain.length - 31);
        expect(await owner.source.read(offset, plain.length - offset)).toEqual(plain.slice(offset));
        expect((await owner.verify()).integrity).toBe("all-chunks-authenticated");
        if (item.name === "python-zip") {
          const zip = await openZip(owner.source);
          const entry = zip.entries.find((entry) => entry.name === native.zip.name);
          expect(entry).toBeDefined();
          expect((await zip.read(entry!.id)).bytes).toEqual(decodeBase64(native.zip.originalBase64));
        }
      } finally {
        await owner.dispose();
      }
    });
  }
  for (const item of cctv.vectors.filter((item) => item.expected !== "success")) {
    it(`refuses CCTV ${item.name}: ${item.expected}`, async () => {
      const key = Uint8Array.from(item.fileKeyHex.match(/../g)!, (byte) => Number.parseInt(byte, 16));
      let owner: AgeOpenedType | undefined;
      const failures: unknown[] = [];
      try {
        owner = await openAge(source(decodeBase64(item.wireBase64)), options({ fileKey: key }));
        // A seek-first reader may detect finality at open, or leave an untouched
        // intermediate unit pending until this complete authentication pass.
        await owner.verify();
      } catch (reason) {
        failures.push(reason);
      } finally {
        await owner?.dispose();
      }
      expect(failures.length).toBe(1);
      expect(failures[0]).toBeInstanceOf(AgeError);
      const error = failures[0] as AgeError;
      if (item.expected === "header failure") {
        expect(owner).toBeUndefined();
        expect(["format", "profile"]).toContain(error.code);
      } else if (item.expected === "HMAC failure") {
        expect(owner).toBeUndefined();
        expect(error.code).toBe("authentication");
      } else {
        expect(item.expected).toBe("payload failure");
        expect(["format", "authentication"]).toContain(error.code);
      }
    });
  }
});
