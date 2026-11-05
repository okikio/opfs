import { describe, it } from "node:test";
import { expect } from "@std/expect";
import { decodeBase64Url, encodeBase64Url } from "@std/encoding/base64url";
import { decodeBase64 } from "@std/encoding/base64";
import { runInNewContext } from "node:vm";
import { createArchiveLedger, JweError, JweProfileSchema, JweProtectedSchema, openJwe } from "../src/crypto/jwe.ts";
import type { JweOpenOptionsType } from "../src/crypto/jwe.ts";
import type { ByteSourceType } from "../src/source.ts";
import { openZip } from "../src/archive/zip.ts";
import official from "./fixtures/jwe/rfc7520.json" with { type: "json" };
import zipFixture from "./fixtures/arfs/zip.json" with { type: "json" };
import native from "./fixtures/jwe/independent.json" with { type: "json" };

const encode = (text: string) => new TextEncoder().encode(text);
const subtle = globalThis.crypto.subtle;
const key = (bytes = 32) => Uint8Array.from({ length: bytes }, (_, i) => i + 1);
const options = (bytes = 32): JweOpenOptionsType => ({
  profile: bytes === 16 ? "jwe-compact-dir-a128gcm" : "jwe-compact-dir-a256gcm",
  key: key(bytes),
  subtle,
});
/** Independent authored RFC grammar around native encryption; no candidate writer exists. */
async function envelope(plain = encode("hello authenticated bytes"), bytes = 32, raw?: string): Promise<Uint8Array> {
  const header = encodeBase64Url(
    encode(raw ?? JSON.stringify({ alg: "dir", enc: bytes === 16 ? "A128GCM" : "A256GCM", kid: "caller key" })),
  );
  const iv = Uint8Array.from({ length: 12 }, (_, i) => i + 40);
  const imported = await subtle.importKey("raw", key(bytes), { name: "AES-GCM" }, false, ["encrypt"]);
  const result = new Uint8Array(
    await subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: encode(header), tagLength: 128 },
      imported,
      new Uint8Array(plain),
    ),
  );
  return encode(
    [header, "", encodeBase64Url(iv), encodeBase64Url(result.subarray(0, -16)), encodeBase64Url(result.subarray(-16))]
      .join("."),
  );
}
/** Override only selected borrowed operations; every other native method retains its actual receiver. */
function capability(overrides: Partial<Pick<SubtleCrypto, "importKey" | "decrypt">>): SubtleCrypto {
  return new Proxy(subtle, {
    get(target, name) {
      if (name === "decrypt" && overrides.decrypt) return overrides.decrypt;
      if (name === "importKey" && overrides.importKey) return overrides.importKey;
      const value: unknown = Reflect.get(target, name, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
async function refuses(run: () => unknown | Promise<unknown>, code: JweError["code"]): Promise<void> {
  try {
    await run();
  } catch (error) {
    expect(error).toBeInstanceOf(JweError);
    expect((error as JweError).code).toBe(code);
    return;
  }
  throw new Error(`Missing ${code} refusal.`);
}
function source(bytes: Uint8Array, action?: () => void): ByteSourceType {
  return {
    size: bytes.length,
    stability: "immutable",
    async read(offset, length) {
      action?.();
      return bytes.slice(offset, offset + length);
    },
  };
}

describe("caller-pinned compact JWE snapshots", () => {
  it("matches the independent published RFC7520 section5.6 complete plaintext digest", async () => {
    const opened = await openJwe(source(encode(official.compact)), {
      profile: "jwe-compact-dir-a128gcm",
      key: decodeBase64Url(official.keyBase64Url),
      subtle,
    });
    try {
      expect(opened.source.size).toBe(official.original.bytes);
      const all = await opened.read(0, opened.source.size);
      const digest = new Uint8Array(await subtle.digest("SHA-256", new Uint8Array(all.bytes)));
      expect(Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("")).toBe(official.original.sha256);
      expect(all.integrity).toBe("whole-jwe-message-authenticated");
      expect(opened.header.protected.enc).toBe("A128GCM");
    } finally {
      opened.dispose();
    }
  });
  for (const bytes of [16, 32]) {
    it(`authenticates owned binary ranges and empty plaintext with ${bytes * 8}-bit keys`, async () => {
      for (const plain of [new Uint8Array(), Uint8Array.from({ length: 257 }, (_, i) => i % 256)]) {
        const opened = await openJwe(source(await envelope(plain, bytes)), options(bytes));
        try {
          expect((await opened.read(0, plain.length)).bytes).toEqual(plain);
          expect(await opened.source.read(plain.length, 0)).toEqual(new Uint8Array());
          expect(opened.work.authenticatedBytes).toBe(plain.length);
        } finally {
          opened.dispose();
        }
      }
    });
  }
  it("composes an authenticated source with the independent Python ZIP producer", async () => {
    const opened = await openJwe(source(await envelope(decodeBase64(zipFixture.wireBase64))), options());
    try {
      const zip = await openZip(opened.source), entry = zip.entries.find((entry) => entry.name === zipFixture.name);
      expect(entry).toBeDefined();
      const read = await zip.read(entry!.id, { offset: 3, length: 19 });
      expect(read.bytes).toEqual(decodeBase64(zipFixture.originalBase64).slice(3, 22));
      expect(opened.integrity).toBe("whole-jwe-message-authenticated");
    } finally {
      opened.dispose();
    }
  });
  it("uses the original encoded protected header as AAD without reserialization", async () => {
    const raw = ' { "enc" : "A256GCM", "custom": {"value":1e99}, "kid":"e\\u0301", "alg":"dir" } ';
    const opened = await openJwe(source(await envelope(encode("ordered bytes"), 32, raw)), options());
    try {
      expect(opened.header.raw).toBe(raw);
      expect(opened.header.protected.kid).toBe("e\u0301");
      expect(new TextDecoder().decode(await opened.source.read(0, 13))).toBe("ordered bytes");
    } finally {
      opened.dispose();
    }
  });
  it("refuses wrong keys and every authenticated-field modification without a plaintext result", async () => {
    const input = await envelope(), parts = new TextDecoder().decode(input).split(".");
    const badKey = key();
    badKey[0] = badKey[0]! ^ 1;
    await refuses(() => openJwe(source(input), { ...options(), key: badKey }), "authentication");
    for (const field of [0, 2, 3, 4]) {
      const changed = parts.slice();
      changed[field] = field === 0
        ? encodeBase64Url(encode('{"alg":"dir","enc":"A256GCM","kid":"other"}'))
        : (changed[field]![0] === "A" ? "B" : "A") + changed[field]!.slice(1);
      await refuses(() => openJwe(source(encode(changed.join("."))), options()), "authentication");
    }
  });
  it("refuses every truncated compact prefix and extra trailing data", async () => {
    const input = await envelope();
    for (let n = 0; n < input.length; n++) {
      let returned = false;
      try {
        const opened = await openJwe(source(input.slice(0, n)), options());
        returned = true;
        opened.dispose();
      } catch {
        // Every incomplete compact prefix must refuse before publishing an owner.
      }
      expect(returned).toBe(false);
    }
    await refuses(() => openJwe(source(encode(new TextDecoder().decode(input) + ".extra")), options()), "format");
    await refuses(() => openJwe(source(encode(new TextDecoder().decode(input) + "\n")), options()), "format");
  });
  it("rejects canonical pad-bit violations before native cryptography", async () => {
    const parts = new TextDecoder().decode(await envelope()).split(".");
    parts[4] = parts[4]!.slice(0, -1) + "B";
    let calls = 0;
    const selected = capability({
      decrypt: async () => {
        calls++;
        throw new Error("unexpected crypto");
      },
      importKey: async () => {
        calls++;
        throw new Error("unexpected crypto");
      },
    });
    await refuses(() => openJwe(source(encode(parts.join("."))), { ...options(), subtle: selected }), "format");
    expect(calls).toBe(0);
  });
  it("rejects duplicate escaped names, BOM, invalid UTF8 and unsupported header authority", async () => {
    const inputs = [
      '{"alg":"dir","enc":"A256GCM","\\u0061lg":"dir"}',
      '{"alg":"dir","enc":"A256GCM","custom":{"x":1,"x":2}}',
      '\ufeff{"alg":"dir","enc":"A256GCM"}',
      '{"alg":"dir","enc":"A256GCM","kid":"\\ud800"}',
    ];
    for (const raw of inputs) {
      await refuses(() => envelope(undefined, 32, raw).then((wire) => openJwe(source(wire), options())), "format");
    }
    const invalid = new TextDecoder().decode(await envelope()).split(".");
    invalid[0] = encodeBase64Url(new Uint8Array([255]));
    await refuses(() => openJwe(source(encode(invalid.join("."))), options()), "format");
    for (const field of ["zip", "crit", "jku", "jwk", "epk", "p2c"]) {
      const raw = JSON.stringify({ alg: "dir", enc: "A256GCM", [field]: field === "crit" ? [] : "untrusted" });
      await refuses(() => envelope(undefined, 32, raw).then((wire) => openJwe(source(wire), options())), "profile");
    }
  });
  it("refuses profile and key-size confusion before source acquisition", async () => {
    let calls = 0;
    const input = source(await envelope(), () => calls++);
    await refuses(() => openJwe(input, { ...options(), key: key(16) }), "key");
    expect(calls).toBe(0);
    const wrong = await subtle.importKey("raw", key(), { name: "AES-GCM" }, false, ["encrypt"]);
    await refuses(() => openJwe(input, { ...options(), key: wrong }), "key");
    expect(calls).toBe(0);
    await refuses(() => openJwe(input, { ...options(), profile: "jwe-compact-dir-a128gcm", key: key(16) }), "profile");
  });
  it("copies the key before later policy, source, subtle or ledger getters can mutate it", async () => {
    for (const boundary of ["policy", "source", "subtle", "ledger"]) {
      const original = key(), wire = await envelope(), supplied = { ...options(), key: original };
      let reads = 0;
      Object.defineProperty(supplied, "key", {
        get() {
          reads++;
          return original;
        },
      });
      let input = source(wire);
      if (boundary === "policy") {
        Object.defineProperty(supplied, "maxHeaderBytes", {
          get() {
            original.fill(0);
            return 8192;
          },
        });
      }
      if (boundary === "source") {
        input = {
          ...input,
          get size() {
            original.fill(0);
            return wire.length;
          },
        };
      }
      if (boundary === "subtle") {
        Object.defineProperty(supplied, "subtle", {
          get() {
            original.fill(0);
            return subtle;
          },
        });
      }
      if (boundary === "ledger") {
        const ledger = {
          get reserve() {
            original.fill(0);
            return () => {};
          },
          inspect: () => ({ sourceBytes: 0, requests: 0, decodedBytes: 0, outputBytes: 0 }),
        };
        Object.defineProperty(supplied, "ledger", { value: ledger });
      }
      const opened = await openJwe(input, supplied);
      try {
        expect((await opened.read(0, 5)).bytes).toEqual(encode("hello"));
        expect(reads).toBe(1);
      } finally {
        opened.dispose();
      }
    }
  });
  it("ignores unrelated option getters and exports a strict known-header schema", async () => {
    const supplied = options();
    Object.defineProperty(supplied, "unrelated", {
      enumerable: true,
      get() {
        throw new Error("unrelated getter");
      },
    });
    const opened = await openJwe(source(await envelope()), supplied);
    try {
      const readOptions = {};
      Object.defineProperty(readOptions, "unrelated", {
        enumerable: true,
        get() {
          throw new Error("unrelated read getter");
        },
      });
      expect((await opened.read(0, 1, readOptions)).bytes).toEqual(encode("h"));
      expect(JweProtectedSchema.safeParse({ alg: "dir", enc: "A256GCM", custom: true }).success).toBe(false);
    } finally {
      opened.dispose();
    }
  });
  it("owns plaintext independently of a crypto provider that retains and mutates its result", async () => {
    let retained!: ArrayBuffer;
    const provider = capability({
      decrypt: async (...args) => {
        retained = await subtle.decrypt(...args);
        return retained;
      },
    });
    const opened = await openJwe(source(await envelope()), { ...options(), subtle: provider });
    new Uint8Array(retained).fill(99);
    try {
      expect((await opened.read(0, 5)).bytes).toEqual(encode("hello"));
    } finally {
      opened.dispose();
    }
    expect(new Uint8Array(retained).every((byte) => byte === 99)).toBe(true);
  });
  it("accepts a borrowed nonextractable native AES key", async () => {
    const imported = await subtle.importKey("raw", key(), { name: "AES-GCM" }, false, ["decrypt"]);
    const opened = await openJwe(source(await envelope()), { ...options(), key: imported });
    try {
      expect(opened.work.nativeCalls).toBe(1);
    } finally {
      opened.dispose();
    }
  });
  it("uses native extents for key and source admission across realms", async () => {
    const input = await envelope(),
      foreign = runInNewContext("(bytes)=>new Uint8Array(bytes)") as (value: Uint8Array) => Uint8Array;
    const opened = await openJwe({
      size: input.length,
      stability: "immutable",
      async read(o, n) {
        return foreign(input.slice(o, o + n));
      },
    }, { ...options(), key: foreign(key()) });
    opened.dispose();
    const short = key(1);
    Object.defineProperty(short, "byteLength", { value: 32 });
    await refuses(() => openJwe(source(input), { ...options(), key: short }), "key");
    await refuses(() =>
      openJwe({
        size: input.length,
        stability: "immutable",
        async read(o, n) {
          const bytes = input.slice(o, o + Math.max(0, n - 1));
          Object.defineProperty(bytes, "byteLength", { value: n });
          return bytes;
        },
      }, options()), "format");
  });
  it("bounds source, decoded, plaintext, header, metadata and retained memory work", async () => {
    const input = await envelope();
    let calls = 0;
    await expect(openJwe(source(input, () => calls++), { ...options(), maxDecodedBytes: 0 })).rejects.toThrow(
      "decodedBytes",
    );
    expect(calls).toBe(0);
    await refuses(() => openJwe(source(input, () => calls++), { ...options(), maxEnvelopeBytes: 1 }), "limit");
    expect(calls).toBe(0);
    for (
      const selected of [
        { maxPlaintextBytes: 0 },
        { maxHeaderBytes: 0 },
        { maxMemoryBytes: 0 },
        { maxHeaderNodes: 0 },
        { maxHeaderDepth: 0 },
        { maxStringBytes: 0 },
      ]
    ) await refuses(() => openJwe(source(input), { ...options(), ...selected }), "limit");
    let cryptoCalls = 0;
    await expect(openJwe(source(input), {
      ...options(),
      maxOutputBytes: 0,
      subtle: capability({
        decrypt: async () => {
          cryptoCalls++;
          throw new Error("unexpected");
        },
        importKey: async () => {
          cryptoCalls++;
          throw new Error("unexpected");
        },
      }),
    })).rejects.toThrow("outputBytes");
    expect(cryptoCalls).toBe(0);
  });
  it("deduplicates a shared inherited ledger while retaining its opening allowance", async () => {
    const plain = encode("12345"), ledger = createArchiveLedger({ maxOutputBytes: plain.length + 1 });
    const opened = await openJwe(source(await envelope(plain)), { ...options(), ledger });
    try {
      expect((await opened.read(0, 1, { ledger })).bytes).toEqual(plain.slice(0, 1));
      await expect(opened.read(0, 1)).rejects.toThrow("outputBytes");
    } finally {
      opened.dispose();
    }
  });
  it("checks abort from the final foreign requests reservation before source I/O", async () => {
    const controller = new AbortController(), why = new Error("quota aborted"), input = await envelope();
    let calls = 0;
    const ledger = {
      reserve(kind: string) {
        if (kind === "requests") controller.abort(why);
      },
      inspect: () => ({ sourceBytes: 0, requests: 0, decodedBytes: 0, outputBytes: 0 }),
    };
    await expect(openJwe(source(input, () => calls++), { ...options(), ledger, signal: controller.signal })).rejects
      .toBe(why);
    expect(calls).toBe(0);
  });
  it("retains parent cancellation when a selected source read supplies a fresh signal", async () => {
    const controller = new AbortController(),
      why = new Error("parent aborted"),
      opened = await openJwe(source(await envelope()), { ...options(), signal: controller.signal });
    try {
      controller.abort(why);
      await expect(opened.source.read(0, 1, { signal: new AbortController().signal })).rejects.toBe(why);
    } finally {
      opened.dispose();
    }
  });
  it("copies reused provider scratch and captures source/options/native methods before awaits", async () => {
    const plain = new Uint8Array(70000).fill(91),
      input = await envelope(plain),
      scratch = new Uint8Array(65536),
      opts = options();
    let calls = 0;
    const supplied = {
      size: input.length,
      stability: "immutable" as const,
      async read(o: number, n: number) {
        calls++;
        supplied.size = 0;
        supplied.read = async () => {
          throw new Error("replaced source");
        };
        Object.assign(opts, { maxPlaintextBytes: 0 });
        scratch.set(input.subarray(o, o + n));
        return scratch.subarray(0, n);
      },
    };
    // Restore the borrowed method only through a captured function; mutation after the first read cannot replace it.
    const original = supplied.read.bind(supplied);
    supplied.read = async (o, n) => original(o, n);
    const opened = await openJwe(supplied, opts);
    try {
      expect((await opened.read(0, plain.length)).bytes).toEqual(plain);
      expect(calls).toBeGreaterThan(1);
    } finally {
      opened.dispose();
    }
  });
  it("disposes reentrantly without exposing zeroed plaintext or revoking earlier owned copies", async () => {
    const opened = await openJwe(source(await envelope()), options()), copy = (await opened.read(0, 5)).bytes;
    const ledger = {
      reserve() {
        opened.dispose();
      },
      inspect: () => ({ sourceBytes: 0, requests: 0, decodedBytes: 0, outputBytes: 0 }),
    };
    await refuses(() => opened.read(0, 1, { ledger }), "disposed");
    expect(new TextDecoder().decode(copy)).toBe("hello");
    await refuses(() => opened.source.read(0, 1), "disposed");
    opened.dispose();
  });
  it("joins pending native decryption without publishing or erasing borrowed late plaintext", async () => {
    let entered!: () => void, release!: () => void;
    const started = new Promise<void>((r) => entered = r),
      gate = new Promise<void>((r) => release = r),
      controller = new AbortController(),
      why = new Error("cancel decrypt");
    let retained: ArrayBuffer | undefined;
    const provider = capability({
      decrypt: async (...args) => {
        retained = await subtle.decrypt(...args);
        entered();
        await gate;
        return retained;
      },
    });
    const pending = openJwe(source(await envelope()), { ...options(), subtle: provider, signal: controller.signal });
    await started;
    controller.abort(why);
    let settled = false;
    void pending.then(() => settled = true, () => settled = true);
    await Promise.resolve();
    expect(settled).toBe(false);
    release();
    await expect(pending).rejects.toBe(why);
    expect(new Uint8Array(retained!)).toEqual(encode("hello authenticated bytes"));
  });
  it("joins a canceled native key import and retains its independent failure", async () => {
    let entered!: () => void, release!: () => void;
    const started = new Promise<void>((r) => entered = r),
      gate = new Promise<void>((r) => release = r),
      controller = new AbortController(),
      why = new Error("cancel key import"),
      failure = new Error("native import failed");
    const provider = capability({
      importKey: async () => {
        entered();
        await gate;
        throw failure;
      },
    });
    const pending = openJwe(source(await envelope()), { ...options(), subtle: provider, signal: controller.signal });
    await started;
    controller.abort(why);
    release();
    try {
      await pending;
      throw new Error("missing rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(AggregateError);
      expect((error as AggregateError).errors).toEqual([why, failure]);
    }
  });
  it("retains a late provider rejection beside cancellation, including undefined", async () => {
    let entered!: () => void, release!: () => void;
    const started = new Promise<void>((r) => entered = r),
      gate = new Promise<void>((r) => release = r),
      controller = new AbortController(),
      why = new Error("cancel native failure");
    const provider = capability({
      decrypt: async () => {
        entered();
        await gate;
        throw undefined;
      },
    });
    const pending = openJwe(source(await envelope()), { ...options(), subtle: provider, signal: controller.signal });
    await started;
    controller.abort(why);
    release();
    try {
      await pending;
      throw new Error("missing rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(AggregateError);
      expect((error as AggregateError).errors).toEqual([why, undefined]);
    }
  });
  it("refuses unverified stability by default and does not invent a plaintext identity", async () => {
    const input = await envelope();
    const opened = await openJwe({ size: input.length, read: source(input).read }, {
      ...options(),
      allowUnverifiedSource: true,
    });
    try {
      expect(opened.source.stability).toBe("immutable");
      expect(opened.source.identity).toBeUndefined();
    } finally {
      opened.dispose();
    }
    await refuses(() => openJwe({ size: input.length, read: source(input).read }, options()), "stability");
    await expect(openJwe({ ...source(input), identity: "x".repeat(8193) }, options())).rejects.toBeInstanceOf(
      TypeError,
    );
  });
});

describe("independent jose 6.2.15 producer and consumer", () => {
  for (const vector of native.cases) {
    it(`matches every native original byte for ${vector.id}`, async () => {
      const original = decodeBase64(vector.originalBase64);
      const opened = await openJwe(source(encode(vector.compact)), {
        profile: JweProfileSchema.parse(vector.profile),
        key: decodeBase64(vector.keyBase64),
        subtle,
      });
      try {
        expect((await opened.read(0, original.length)).bytes).toEqual(original);
        expect(opened.source.size).toBe(vector.originalBytes);
        expect(opened.header.protected).toEqual(vector.protected);
        expect(opened.header.encoded).toBe(vector.compact.split(".")[0]);
        expect(opened.work.authenticatedBytes).toBe(original.length);
        expect(opened.integrity).toBe("whole-jwe-message-authenticated");
      } finally {
        opened.dispose();
      }
    });
    if (vector.id.endsWith("-zip")) {
      it(`previews the independent Python ZIP inside ${vector.id}`, async () => {
        const opened = await openJwe(source(encode(vector.compact)), {
          profile: JweProfileSchema.parse(vector.profile),
          key: decodeBase64(vector.keyBase64),
          subtle,
        });
        try {
          const zip = await openZip(opened.source), entry = zip.entries.find((item) => item.name === zipFixture.name);
          expect(entry).toBeDefined();
          expect((await zip.read(entry!.id, { offset: 3, length: 19 })).bytes).toEqual(
            decodeBase64(zipFixture.originalBase64).slice(3, 22),
          );
        } finally {
          opened.dispose();
        }
      });
    }
  }
});
