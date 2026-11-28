/** Installed crypto contracts. Each case owns its state and exact source oracle. */
import { describe, it } from "node:test";
import { createCipheriv, createDecipheriv } from "node:crypto";
import { env, versions } from "node:process";
import { fileURLToPath } from "node:url";
import { AgeError, openAge } from "@okikio/opfs/crypto/age";
import { createNodeAgeAead } from "@okikio/opfs/crypto/age-node";
import { createDenoAgeOracle } from "../age-provider.ts";
import { createByteSource } from "@okikio/opfs/source";
import { createNativeTink } from "@okikio/opfs/crypto/tink";
import { openZip } from "@okikio/opfs/archive/zip";
import { JweProtectedSchema, openJwe } from "@okikio/opfs/crypto/jwe";
import { openCryptomator } from "@okikio/opfs/crypto/cryptomator";
import { assertBytes, bytes, fromBase64 } from "../bytes.mjs";
import cryptomatorInput from "../data/crypto/cryptomator.json" with { type: "json" };
import jweInput from "../data/crypto/jwe.json" with { type: "json" };
import jweZipInput from "../data/crypto/jwezip.json" with { type: "json" };
import ageInput from "../data/crypto/age.json" with { type: "json" };

// Preserve the original named-export import check alongside the executable JWE contract.
void JweProtectedSchema;

describe("packed crypto", () => {
  it("authenticated Tink ranges", async () => {
    const profile = createNativeTink();
    const key = globalThis.crypto.getRandomValues(new Uint8Array(32));
    const aad = new TextEncoder().encode("packed-consumer-v1");
    const ciphertext = new Uint8Array(
      await new Response(profile.encrypt(createByteSource(bytes), key, aad)).arrayBuffer(),
    );
    const encrypted = await profile.open(createByteSource(ciphertext), key, aad);
    const selected = await encrypted.readVerified(65530, 7);
    if (
      selected.scope !== "authenticated-segments" ||
      selected.bytes.some((value, index) => value !== bytes[65530 + index])
    ) {
      throw new Error("Packed authenticated range mismatch");
    }
  });
  it("Cryptomator authenticated nested archive ranges", async () => {
    const cryptomatorFixture = cryptomatorInput;
    /** Decode the retained producer wire independently of the candidate vault. */
    const cryptomatorBytes = (value) => Uint8Array.from(atob(value), (byte) => byte.charCodeAt(0));
    const cryptomator = await openCryptomator(
      new TextEncoder().encode(cryptomatorFixture.configuration),
      cryptomatorBytes(cryptomatorFixture.key),
      { subtle: globalThis.crypto.subtle },
    );
    let cryptomatorFile;
    try {
      const named = await cryptomator.decryptName(
        cryptomatorFixture.named.encryptedName,
        cryptomatorFixture.named.parent,
      );
      if (named.name !== cryptomatorFixture.named.name || named.scope !== "name-and-parent-authenticated") {
        throw new Error("Packed Cryptomator name authentication changed");
      }
      const ciphertext = cryptomatorBytes(cryptomatorFixture.nested.ciphertext);
      const encrypted = createByteSource(ciphertext);
      let physicalBytes = 0;
      cryptomatorFile = await cryptomator.open({
        size: encrypted.size,
        stability: "immutable",
        read: async (at, length, options) => {
          physicalBytes += length;
          return await encrypted.read(at, length, options);
        },
      });
      const nestedZip = await openZip(cryptomatorFile);
      const member = nestedZip.entries.find((entry) => entry.name === "selected.txt");
      if (!member) throw new Error("Packed Cryptomator nested ZIP member is absent");
      const selected = await nestedZip.read(member.id);
      assertBytes(selected.bytes, new TextEncoder().encode("authenticated nested archive preview\n"));
      if (
        cryptomatorFile.header !== "authenticated" || cryptomatorFile.originalLength !== "not-authenticated" ||
        physicalBytes >= ciphertext.length / 2
      ) throw new Error("Packed Cryptomator preview scope or selected-read cost changed");
    } finally {
      try {
        if (cryptomatorFile) await cryptomatorFile[Symbol.asyncDispose]();
      } finally {
        await cryptomator[Symbol.asyncDispose]();
      }
    }
  });
  it("JWE whole-message authentication and disposal", async () => {
    const jweNative = jweInput;
    const jweZip = jweZipInput;
    if (jweNative.cases.length !== 8) throw new Error("Packed JWE native coverage changed");
    for (const vector of jweNative.cases) {
      const original = fromBase64(vector.originalBase64), wire = new TextEncoder().encode(vector.compact);
      const message = await openJwe(createByteSource(wire), {
        profile: vector.profile,
        key: fromBase64(vector.keyBase64),
        subtle: globalThis.crypto.subtle,
      });
      try {
        if (
          message.integrity !== "whole-jwe-message-authenticated" || message.source.size !== vector.originalBytes ||
          message.work.authenticatedBytes !== original.length
        ) throw new Error("Packed JWE authentication scope changed");
        if (
          message.header.encoded !== vector.compact.split(".")[0] ||
          Object.keys(message.header.protected).length !== Object.keys(vector.protected).length ||
          Object.entries(vector.protected).some(([key, value]) => message.header.protected[key] !== value)
        ) throw new Error("Packed JWE protected header changed");
        assertBytes((await message.read(0, original.length)).bytes, original);
        assertBytes(await message.source.read(original.length, 0), new Uint8Array());
        if (vector.id.endsWith("-zip")) {
          const archive = await openZip(message.source),
            entry = archive.entries.find((value) => value.name === jweZip.name);
          if (!entry) throw new Error("Packed JWE nested ZIP member missing");
          assertBytes(
            (await archive.read(entry.id, { offset: 3, length: 19 })).bytes,
            fromBase64(jweZip.originalBase64).slice(3, 22),
          );
        }
      } finally {
        message.dispose();
      }
      let refused = false;
      try {
        await message.source.read(0, 0);
      } catch (error) {
        if (error?.code !== "disposed") throw error;
        refused = true;
      }
      if (!refused) throw new Error("Packed disposed JWE source remained readable");
    }
  });
  // This full native corpus uses bounded Deno oracle children on Bun. Its five-second
  // child watchdog remains unchanged; the case retains the former whole-program
  // twenty-minute operational ceiling instead of Bun's five-second test default.
  it("native age authenticated selections and host capability", { timeout: 20 * 60_000 }, async () => {
    const ageNative = ageInput;
    if (ageNative.records.length !== 8 || ageNative.corpus.length !== 8) {
      throw new Error("Packed age native coverage changed");
    }
    /** Recover the fixture file key from its exact hexadecimal producer record. */
    const ageKey = (hex) => Uint8Array.from(hex.match(/../g), (byte) => Number.parseInt(byte, 16));
    const ageNativeAead = createNodeAgeAead({ createDecipheriv });
    // Bun always uses the same explicit, bounded test-only provider as its source tests.
    // Deno and Node never read environment or spawn a child through this branch.
    const ageAead = versions.bun === undefined ? ageNativeAead : createDenoAgeOracle(
      "deno",
      fileURLToPath(new URL("../age-oracle.ts", import.meta.url)),
      AgeError,
      { PATH: env.PATH ?? "", ...(env.SystemRoot ? { SystemRoot: env.SystemRoot } : {}) },
    );
    for (const vector of [...ageNative.records, ...ageNative.corpus]) {
      const original = fromBase64(vector.originalBase64), wire = fromBase64(vector.wireBase64);
      const owner = await openAge(createByteSource(wire), {
        profile: "age-v1-file-key",
        fileKey: ageKey(vector.fileKeyHex),
        subtle: globalThis.crypto.subtle,
        aead: ageAead,
      });
      try {
        if (owner.size !== original.length || owner.integrity !== "header-and-final-chunk-authenticated") {
          throw new Error("Packed age opening scope changed");
        }
        const whole = await owner.read(0, owner.size);
        assertBytes(whole.bytes, original);
        if (whole.integrity !== "selected-chunks-authenticated") {
          throw new Error("Packed age selected authentication changed");
        }
        const verified = await owner.verify();
        if (verified.integrity !== "all-chunks-authenticated" || verified.work.authenticatedBytes !== original.length) {
          throw new Error("Packed age complete authentication changed");
        }
        assertBytes(await owner.source.read(0, owner.size), original);
      } finally {
        await owner.dispose();
      }
    }
    // Native factory availability is a separate contract, not a reason to skip portable cases.
    const ageProbeFailures = [];
    try {
      createCipheriv("chacha20-poly1305", new Uint8Array(32), new Uint8Array(12), { authTagLength: 16 });
    } catch (reason) {
      ageProbeFailures.push(reason);
    }
    if (ageProbeFailures.length) {
      if (versions.bun === undefined || ageProbeFailures[0]?.code !== "ERR_CRYPTO_UNKNOWN_CIPHER") {
        throw ageProbeFailures[0];
      }
      const failures = [];
      try {
        await ageNativeAead.decrypt(new Uint8Array(32), new Uint8Array(12), new Uint8Array(16));
      } catch (reason) {
        failures.push(reason);
      }
      if (failures.length !== 1 || failures[0]?.code !== "ERR_CRYPTO_UNKNOWN_CIPHER") {
        throw new Error("Packed age native unsupported-cipher contract changed");
      }
    } else {
      const vector = ageNative.records.find((value) => value.name === "bytes-65537");
      if (!vector) throw new Error("Packed age native availability fixture absent");
      const owner = await openAge(createByteSource(fromBase64(vector.wireBase64)), {
        profile: "age-v1-file-key",
        fileKey: ageKey(vector.fileKeyHex),
        subtle: globalThis.crypto.subtle,
        aead: ageNativeAead,
      });
      try {
        assertBytes((await owner.read(0, owner.size)).bytes, fromBase64(vector.originalBase64));
      } finally {
        await owner.dispose();
      }
    }
  });
});
