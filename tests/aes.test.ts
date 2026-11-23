import { describe, it } from "node:test";
import { expect } from "@std/expect";
import { decodeBase64 } from "@std/encoding/base64";
import { createBlobSource } from "../src/source.ts";
import { createArchiveLedger, openZip } from "../src/archive/zip.ts";
import fixtures from "./fixtures/aes/independent.json" with { type: "json" };

const source = (bytes: Uint8Array) => createBlobSource(new Blob([new Uint8Array(bytes).buffer]));
const password = decodeBase64(fixtures["aes256-ae2"].password);
const aes = { subtle: crypto.subtle };
/** Navigate independent ZIP fixed fields without consulting candidate private metadata. */
function positions(bytes: Uint8Array, name = "first.bin") {
  const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let central = data.getUint32(bytes.length - 6, true);
  while (
    new TextDecoder().decode(bytes.subarray(central + 46, central + 46 + data.getUint16(central + 28, true))) !== name
  ) {
    central += 46 + data.getUint16(central + 28, true) + data.getUint16(central + 30, true) +
      data.getUint16(central + 32, true);
  }
  const local = data.getUint32(central + 42, true);
  const localExtra = local + 30 + data.getUint16(local + 26, true);
  const centralExtra = central + 46 + data.getUint16(central + 28, true);
  const payload = localExtra + data.getUint16(local + 28, true);
  const find = (offset: number, length: number): number => {
    const end = offset + length;
    while (offset < end) {
      if (data.getUint16(offset, true) === 0x9901) return offset + 4;
      offset += 4 + data.getUint16(offset + 2, true);
    }
    throw new Error("Independent fixture has no AES extra.");
  };
  return {
    data,
    central,
    local,
    payload,
    localAes: find(localExtra, data.getUint16(local + 28, true)),
    centralAes: find(centralExtra, data.getUint16(central + 30, true)),
  };
}
/** Keep real native method receivers while counting when plaintext operations become reachable. */
function observe(callback: (method: string) => void): SubtleCrypto {
  return new Proxy(crypto.subtle, {
    get(target, property) {
      const value: unknown = Reflect.get(target, property, target);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        callback(String(property));
        return Reflect.apply(value, target, args);
      };
    },
  });
}

describe("bounded WinZip AES authentication", () => {
  for (const profile of ["aes128-ae2", "aes192-ae2", "aes256-ae2", "aes128-ae1", "aes192-ae1", "aes256-ae1"] as const) {
    it(`reads ${profile} with independent libarchive full-payload evidence`, async () => {
      const fixture = fixtures[profile];
      expect(fixture.independentPayloadVerified).toBe(true);
      const bytes = decodeBase64(fixture.archive);
      const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(bytes)));
      expect(Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("")).toBe(fixture.sha256);
      const archive = await openZip(source(bytes));
      for (const expected of fixture.entries) {
        const entry = archive.entries.find((entry) => entry.name === expected.name)!;
        expect(entry.encryption).toBe("winzip-aes");
        const result = await archive.read(entry.id, { password, aes, verify: true });
        expect(result.bytes).toEqual(decodeBase64(expected.body));
        expect(result.integrity).toBe(profile.endsWith("ae2") ? "not-provided" : "checksum-verified");
        expect(result.encryption).toEqual({ kind: "winzip-aes", authentication: "ciphertext-verified" });
      }
    });
  }
  it("authenticates a whole member then decrypts only covering blocks, including little-endian counter carry", async () => {
    const archive = await openZip(source(decodeBase64(fixtures["aes256-ae2"].archive)));
    const entry = archive.entries.find((entry) => entry.name === "large.bin")!;
    const body = decodeBase64(fixtures["aes256-ae2"].entries.find((entry) => entry.name === "large.bin")!.body);
    const calls: string[] = [];
    const options = { password, aes: { subtle: observe((method) => calls.push(method)) }, offset: 4079, length: 38 };
    const plan = archive.plan(entry.id, options);
    expect(plan).toMatchObject({
      supported: true,
      access: "authenticated-range",
      authentication: "full-member-hmac",
      cryptoBlocks: 4,
      sourceBytes: entry.compressedSize,
      decodedBytes: entry.size * 2 + 64,
    });
    const result = await archive.read(entry.id, options);
    expect(result.bytes).toEqual(body.slice(4079, 4117));
    expect(result.work.decodedBytes).toBe(plan.decodedBytes);
    expect(calls.filter((method) => method === "sign").length).toBe(1);
    expect(calls.filter((method) => method === "verify").length).toBe(1);
    expect(calls.filter((method) => method === "decrypt").length).toBe(4);
    expect(calls.indexOf("verify")).toBeLessThan(calls.indexOf("decrypt"));
  });
  it("refuses wrong passwords and tampered salt, verifier, ciphertext or tag before any plaintext native call", async () => {
    const original = decodeBase64(fixtures["aes256-ae2"].archive);
    for (const location of ["salt", "verifier", "ciphertext", "tag", "password"] as const) {
      const bytes = original.slice();
      const { data, central, payload } = positions(bytes);
      const size = data.getUint32(central + 20, true);
      const at = location === "salt"
        ? payload
        : location === "verifier"
        ? payload + 16
        : location === "ciphertext"
        ? payload + 18 + 50
        : payload + size - 1;
      if (location !== "password") bytes[at] = bytes[at]! ^ 1;
      let decrypts = 0;
      const archive = await openZip(source(bytes));
      await expect(
        archive.read(archive.entries.find((entry) => entry.name === "first.bin")!.id, {
          password: location === "password" ? new Uint8Array([1, 2]) : password,
          aes: {
            subtle: observe((method) => {
              if (method === "decrypt") decrypts++;
            }),
          },
          length: 1,
        }),
      ).rejects.toMatchObject({ code: "checksum-mismatch" });
      expect(decrypts).toBe(0);
    }
  });
  it("separates AE-1 CRC from authenticated ciphertext and refuses disagreeing local metadata", async () => {
    const bytes = decodeBase64(fixtures["aes256-ae1"].archive);
    const { data, local, central } = positions(bytes);
    data.setUint32(local + 14, 0x12345678, true);
    data.setUint32(central + 16, 0x12345678, true);
    const archive = await openZip(source(bytes));
    const prefix = await archive.read(archive.entries.find((entry) => entry.name === "first.bin")!.id, {
      password,
      aes,
      length: 3,
    });
    expect(prefix.integrity).toBe("checksum-pending");
    expect(prefix.encryption?.authentication).toBe("ciphertext-verified");
    await expect(
      archive.read(archive.entries.find((entry) => entry.name === "first.bin")!.id, {
        password,
        aes,
        length: 3,
        verify: true,
      }),
    ).rejects.toMatchObject({
      code: "checksum-mismatch",
    });
    for (const displacement of [0, 2, 4, 5]) {
      const changed = decodeBase64(fixtures["aes256-ae2"].archive);
      const at = positions(changed).localAes + displacement;
      changed[at] = changed[at]! ^ 1;
      const opened = await openZip(source(changed));
      await expect(opened.read(opened.entries.find((entry) => entry.name === "first.bin")!.id, { password, aes }))
        .rejects.toMatchObject({ code: "invalid-archive" });
    }
  });
  it("refuses missing AES capability without source reads; budgets admit before native calls", async () => {
    const bytes = decodeBase64(fixtures["aes256-ae2"].archive);
    let reads = 0;
    const archive = await openZip({
      size: bytes.length,
      stability: "immutable",
      async read(offset, length) {
        reads++;
        return bytes.slice(offset, offset + length);
      },
    });
    const entry = archive.entries.find((entry) => entry.name === "large.bin")!;
    const before = reads;
    await expect(archive.read(entry.id, { password })).rejects.toMatchObject({ code: "unsupported-profile" });
    await expect(archive.read(entry.id, { aes })).rejects.toMatchObject({ code: "unsupported-profile" });
    expect(reads).toBe(before);
    let native = 0;
    const capability = { subtle: observe(() => native++) };
    for (
      const options of [
        { aes: { ...capability, maxBlocks: 1 } },
        { aes: { ...capability, maxCiphertextBytes: 1 } },
        { maxDecodedBytes: 1 },
        { maxOutputBytes: 0 },
        { maxRequests: 0 },
        { maxSourceBytes: 0 },
      ]
    ) {
      await expect(archive.read(entry.id, { password, aes: capability, length: 33, ...options })).rejects.toMatchObject(
        { code: "budget-exceeded" },
      );
    }
    expect(native).toBe(0);
    expect(() => archive.plan(entry.id, { password, aes: { ...aes, maxBlocks: 8193 } })).toThrow(RangeError);
    const deflate = await openZip(source(decodeBase64(fixtures.deflate.archive)));
    expect(deflate.entries[0]!.encryption).toBe("winzip-aes");
    expect((await deflate.read(0, { password, aes })).bytes).toEqual(decodeBase64(fixtures.deflate.entries[0]!.body));
    const ledger = createArchiveLedger({ maxDecodedBytes: entry.size * 4 + 16 });
    await archive.read(entry.id, { password, aes, length: 1, ledger });
    await expect(archive.read(entry.id, { password, aes, length: 1, ledger })).rejects.toMatchObject({
      code: "budget-exceeded",
    });
  });
  it("keeps AE-2 verify:true range-only and refuses aggregate output before any additional decrypt call", async () => {
    const archive = await openZip(source(decodeBase64(fixtures["aes256-ae2"].archive)));
    const entry = archive.entries.find((entry) => entry.name === "large.bin")!;
    let decrypts = 0;
    const native = {
      subtle: observe((method) => {
        if (method === "decrypt") decrypts++;
      }),
    };
    const ledger = createArchiveLedger({ maxOutputBytes: 1 });
    const result = await archive.read(entry.id, { password, aes: native, length: 1, verify: true, ledger });
    expect(result.integrity).toBe("not-provided");
    expect(decrypts).toBe(1);
    await expect(archive.read(entry.id, { password, aes: native, length: 1, ledger })).rejects.toMatchObject({
      code: "budget-exceeded",
    });
    expect(decrypts).toBe(1);
    const changed = decodeBase64(fixtures["aes256-ae2"].archive);
    const { data, local, central } = positions(changed);
    data.setUint16(local + 6, data.getUint16(local + 6, true) | 8, true);
    data.setUint16(central + 8, data.getUint16(central + 8, true) | 8, true);
    const descriptor = await openZip(source(changed));
    expect(descriptor.entries.find((entry) => entry.name === "first.bin")!.encryption).toBe("unsupported");
    const malformed = decodeBase64(fixtures["aes256-ae2"].archive);
    const control = positions(malformed);
    control.data.setUint32(control.local + 18, control.data.getUint32(control.local + 18, true) - 1, true);
    control.data.setUint32(control.central + 20, control.data.getUint32(control.central + 20, true) - 1, true);
    const truncated = await openZip(source(malformed));
    await expect(truncated.read(truncated.entries.find((entry) => entry.name === "first.bin")!.id, { password, aes }))
      .rejects.toMatchObject({ code: "invalid-archive" });
  });
  it("decodes independent AES DEFLATE and lowered ordinary-version controls with honest CRC scope", async () => {
    for (const name of ["deflate", "deflate-needed20", "deflate-ae1", "stored-needed10"] as const) {
      const fixture = fixtures[name];
      expect(fixture.independentPayloadVerified).toBe(true);
      const archive = await openZip(source(decodeBase64(fixture.archive)));
      for (const expected of fixture.entries) {
        const entry = archive.entries.find((entry) => entry.name === expected.name)!;
        const plan = archive.plan(entry.id, { password, aes, verify: true });
        if (entry.aes?.method === 8) {
          expect(plan.access).toBe("decode-from-start");
          expect(plan.verification).toBe(name === "deflate-ae1" ? "full-member-crc" : "full-member-decode");
        }
        const result = await archive.read(entry.id, { password, aes, verify: true });
        expect(result.bytes).toEqual(decodeBase64(expected.body));
        expect(result.integrity).toBe(name === "deflate-ae1" ? "checksum-verified" : "not-provided");
        if (entry.aes?.method === 8) {
          const compressed = entry.compressedSize - entry.aes.strength / 16 - 12;
          expect(result.work.decodedBytes).toBe(compressed * 3 + entry.size);
          expect(plan.cryptoBlocks).toBe(Math.ceil(compressed / 16));
        }
      }
    }
  });
  it("authenticates the complete compressed member before decryption or inflater construction", async () => {
    const fixture = fixtures.deflate;
    for (const wrong of [false, true]) {
      const bytes = decodeBase64(fixture.archive);
      const { data, central, payload } = positions(bytes, "large.bin");
      if (!wrong) {
        const at = payload + data.getUint32(central + 20, true) - 12;
        bytes[at] = bytes[at]! ^ 1;
      }
      let decrypt = 0;
      let factories = 0;
      const archive = await openZip(source(bytes));
      await expect(
        archive.read(0, {
          password: wrong ? new Uint8Array([1]) : password,
          aes: {
            subtle: observe((method) => {
              if (method === "decrypt") decrypt++;
            }),
          },
          length: 1,
          inflate() {
            factories++;
            return new TransformStream<Uint8Array, Uint8Array>();
          },
        }),
      ).rejects.toMatchObject({ code: "checksum-mismatch" });
      expect(decrypt).toBe(0);
      expect(factories).toBe(0);
    }
  });
  it("charges HMAC, compressed decryption and inflated prefix together and checks exact decoded size", async () => {
    const archive = await openZip(source(decodeBase64(fixtures.deflate.archive)));
    const entry = archive.entries[0]!;
    const compressed = entry.compressedSize - 28;
    const prefix = await archive.read(0, { password, aes, offset: 4000, length: 17 });
    expect(prefix.bytes).toEqual(decodeBase64(fixtures.deflate.entries[0]!.body).slice(4000, 4017));
    expect(prefix.encryption?.authentication).toBe("ciphertext-verified");
    await expect(archive.read(0, { password, aes, length: 1, maxDecodedBytes: compressed * 3 + 1 })).rejects
      .toMatchObject({ code: "budget-exceeded" });
    await expect(archive.read(0, { password, aes: { ...aes, maxBlocks: 1 }, length: 1 })).rejects.toMatchObject({
      code: "budget-exceeded",
    });
    const ledger = createArchiveLedger({ maxDecodedBytes: compressed * 6 + entry.size * 2 - 1 });
    await archive.read(0, { password, aes, ledger });
    await expect(archive.read(0, { password, aes, ledger })).rejects.toMatchObject({ code: "budget-exceeded" });
    for (const difference of [-1, 1]) {
      const bytes = decodeBase64(fixtures.deflate.archive);
      const { data, local, central } = positions(bytes, "large.bin");
      data.setUint32(local + 22, entry.size + difference, true);
      data.setUint32(central + 24, entry.size + difference, true);
      const changed = await openZip(source(bytes));
      await expect(changed.read(0, { password, aes, verify: true })).rejects.toMatchObject({ code: "invalid-archive" });
    }
    const bytes = decodeBase64(fixtures["deflate-ae1"].archive);
    const { data, local, central } = positions(bytes, "large.bin");
    data.setUint32(local + 14, 0x12345678, true);
    data.setUint32(central + 16, 0x12345678, true);
    const changed = await openZip(source(bytes));
    expect((await changed.read(0, { password, aes, length: 1 })).integrity).toBe("checksum-pending");
    await expect(changed.read(0, { password, aes, length: 1, verify: true })).rejects.toMatchObject({
      code: "checksum-mismatch",
    });
  });
  it("awaits an in-flight compressed AES block before clearing ciphertext or acquiring a decoder", async () => {
    const archive = await openZip(source(decodeBase64(fixtures.deflate.archive)));
    const abort = new AbortController();
    let factories = 0;
    let reached!: () => void;
    const started = new Promise<void>((resolve) => reached = resolve);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => release = resolve);
    let held = false;
    const native = new Proxy(crypto.subtle, {
      get(target, property) {
        if (property === "decrypt") {
          return async (...args: Parameters<SubtleCrypto["decrypt"]>) => {
            if (!held) {
              held = true;
              const snapshot = new Uint8Array(
                args[2] instanceof ArrayBuffer ? args[2] : args[2].buffer,
                args[2] instanceof ArrayBuffer ? 0 : args[2].byteOffset,
                args[2] instanceof ArrayBuffer ? args[2].byteLength : args[2].byteLength,
              ).slice();
              reached();
              await gate;
              const current = new Uint8Array(
                args[2] instanceof ArrayBuffer ? args[2] : args[2].buffer,
                args[2] instanceof ArrayBuffer ? 0 : args[2].byteOffset,
                args[2].byteLength,
              );
              expect(current).toEqual(snapshot);
            }
            return target.decrypt(...args);
          };
        }
        const value: unknown = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    let settled = false;
    const pending = archive.read(0, {
      password,
      aes: { subtle: native },
      signal: abort.signal,
      inflate() {
        factories++;
        return new TransformStream<Uint8Array, Uint8Array>();
      },
    });
    const observed = pending.then(() => {
      settled = true;
    }, () => {
      settled = true;
    });
    await started;
    abort.abort(new Error("stop-compressed-aes"));
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(factories).toBe(0);
    release();
    await expect(pending).rejects.toThrow("stop-compressed-aes");
    await observed;
    expect(factories).toBe(0);
  });
  it("retires a pending or prefix inflater and preserves its own cleanup failure", async () => {
    const archive = await openZip(source(decodeBase64(fixtures.deflate.archive)));
    let cancelled = 0;
    let inputBytes = 0;
    const cleanup = new Error("AES inflater cancellation failed");
    await expect(archive.read(0, {
      password,
      aes,
      length: 1,
      inflate: () => ({
        readable: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array([17]));
          },
          cancel() {
            cancelled++;
            throw cleanup;
          },
        }),
        writable: new WritableStream<Uint8Array>({
          write(chunk) {
            inputBytes += chunk.length;
          },
        }),
      }),
    })).rejects.toBe(cleanup);
    expect(cancelled).toBe(1);
    expect(inputBytes).toBeGreaterThan(0);
    const abort = new AbortController();
    let reached!: () => void;
    const started = new Promise<void>((resolve) => reached = resolve);
    const pending = archive.read(0, {
      password,
      aes,
      signal: abort.signal,
      inflate: () => ({
        readable: new ReadableStream<Uint8Array>({
          pull() {
            reached();
          },
          cancel() {
            cancelled++;
          },
        }, { highWaterMark: 0 }),
        writable: new WritableStream<Uint8Array>(),
      }),
    });
    await started;
    abort.abort(new Error("stop-aes-inflater"));
    await expect(pending).rejects.toThrow("stop-aes-inflater");
    expect(cancelled).toBe(2);
    const factoryFailure = new Error("AES codec factory failed");
    await expect(archive.read(0, {
      password,
      aes,
      inflate() {
        throw factoryFailure;
      },
    })).rejects.toBe(factoryFailure);
  });
  it("copies passwords before source await and waits for an in-flight nonabortable native operation", async () => {
    const bytes = decodeBase64(fixtures["aes256-ae2"].archive);
    const caller = password.slice();
    let mutate = false;
    const archive = await openZip({
      size: bytes.length,
      stability: "immutable",
      async read(offset, length) {
        if (mutate) caller.fill(0);
        return bytes.slice(offset, offset + length);
      },
    });
    mutate = true;
    expect(
      (await archive.read(archive.entries.find((entry) => entry.name === "first.bin")!.id, {
        password: caller,
        aes,
        length: 1,
      })).bytes.length,
    ).toBe(1);
    const abort = new AbortController();
    let reached!: () => void;
    const started = new Promise<void>((resolve) => reached = resolve);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => release = resolve);
    const native = new Proxy(crypto.subtle, {
      get(target, property) {
        if (property === "deriveBits") {
          return async (...args: Parameters<SubtleCrypto["deriveBits"]>) => {
            const result = await target.deriveBits(...args);
            reached();
            await gate;
            return result;
          };
        }
        const value: unknown = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    let settled = false;
    const pending = archive.read(archive.entries.find((entry) => entry.name === "first.bin")!.id, {
      password,
      aes: { subtle: native },
      signal: abort.signal,
    });
    const observed = pending.then(() => {
      settled = true;
    }, () => {
      settled = true;
    });
    await started;
    abort.abort(new Error("stop-native"));
    await Promise.resolve();
    expect(settled).toBe(false);
    release();
    await expect(pending).rejects.toThrow("stop-native");
    await observed;
    const truncated = bytes.slice(0, -1);
    await expect(openZip(source(truncated))).rejects.toMatchObject({ code: "invalid-archive" });
  });
});
