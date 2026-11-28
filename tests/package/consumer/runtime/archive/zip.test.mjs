/** Installed archive zip contracts. Each case owns its state and exact source oracle. */
import { describe, it } from "node:test";
import { createFileSystem } from "@okikio/opfs";
import { createByteSource } from "@okikio/opfs/source";
import { createZipStream } from "@okikio/opfs/archive/zip/write";
import { openZip } from "@okikio/opfs/archive/zip";
import { createZipAdapter } from "@okikio/opfs/view/zip";
import { archivePayload, assertBytes } from "../../bytes.mjs";
import passwordInput from "../../data/archive/password.json" with { type: "json" };
import aesInput from "../../data/archive/aes.json" with { type: "json" };
import zipBzipInput from "../../data/archive/zipbzip.json" with { type: "json" };
import zipLzmaInput from "../../data/archive/ziplzma.json" with { type: "json" };

describe("packed archive zip", () => {
  it("ZipCrypto evidence", async () => {
    const passwordFixture = passwordInput;
    const passwordZip = await openZip(
      createByteSource(Uint8Array.from(atob(passwordFixture.archive), (byte) => byte.charCodeAt(0))),
    );
    const passwordEntry = passwordZip.entries.find((entry) => entry.name === "first.bin");
    const passwordRead = await passwordZip.read(passwordEntry.id, {
      password: Uint8Array.from(atob(passwordFixture.password), (byte) => byte.charCodeAt(0)),
    });
    assertBytes(
      passwordRead.bytes,
      Uint8Array.from(
        atob(passwordFixture.entries.find((entry) => entry.name === "first.bin").body),
        (byte) => byte.charCodeAt(0),
      ),
    );
    if (passwordRead.encryption.authentication !== "none" || passwordRead.integrity !== "checksum-verified") {
      throw new Error("Packed ZipCrypto evidence changed");
    }
  });
  it("AES authentication and decode-plan evidence", async () => {
    const aesFixtures = aesInput;
    for (const aesFixture of aesFixtures) {
      const aesZip = await openZip(
        createByteSource(Uint8Array.from(atob(aesFixture.archive), (byte) => byte.charCodeAt(0))),
      );
      const aesEntry = aesZip.entries.find((entry) => entry.name === aesFixture.entries[0].name);
      const aesRead = await aesZip.read(aesEntry.id, {
        verify: true,
        password: Uint8Array.from(atob(aesFixture.password), (byte) => byte.charCodeAt(0)),
        aes: { subtle: globalThis.crypto.subtle },
      });
      assertBytes(aesRead.bytes, Uint8Array.from(atob(aesFixture.entries[0].body), (byte) => byte.charCodeAt(0)));
      if (
        aesRead.integrity !== (aesEntry.aes.version === 1 ? "checksum-verified" : "not-provided") ||
        aesRead.encryption.authentication !== "ciphertext-verified"
      ) throw new Error("Packed AES scope changed");
      const aesPlan = aesZip.plan(aesEntry.id, {
        verify: true,
        password: Uint8Array.from(atob(aesFixture.password), (byte) => byte.charCodeAt(0)),
        aes: { subtle: globalThis.crypto.subtle },
      });
      if (aesEntry.aes.method === 8 && aesEntry.aes.version === 2 && aesPlan.verification !== "full-member-decode") {
        throw new Error("Packed AES DEFLATE plan scope changed");
      }
    }
  });
  it("BZip2 and LZMA ZIP composition and view ownership", async () => {
    const zipBzipFixture = zipBzipInput;
    const zipBzip = await openZip(
      createByteSource(Uint8Array.from(atob(zipBzipFixture.wire), (byte) => byte.charCodeAt(0))),
    );
    const zipBzipEntry = zipBzip.entries.find((item) => item.name === zipBzipFixture.member.name);
    const zipBzipRead = await zipBzip.read(zipBzipEntry.id, { bzip: { inputChunkBytes: 3, outputChunkBytes: 7 } });
    assertBytes(
      zipBzipRead.bytes,
      Uint8Array.from(atob(zipBzipFixture.member.original.base64), (byte) => byte.charCodeAt(0)),
    );
    if (
      zipBzipRead.integrity !== "checksum-verified" || zipBzipRead.codec?.kind !== "bzip2" ||
      zipBzipRead.codec.integrity !== "checksum-verified"
    ) throw new Error("Packed ZIP BZip2 verification changed");
    const zipLzmaFixture = zipLzmaInput;
    const zipLzma = await openZip(
      createByteSource(Uint8Array.from(atob(zipLzmaFixture.wire), (byte) => byte.charCodeAt(0))),
    );
    const zipLzmaEntry = zipLzma.entries.find((item) => item.name === zipLzmaFixture.member.name);
    const zipLzmaRead = await zipLzma.read(zipLzmaEntry.id, {
      lzma: { inputChunkBytes: 3, maxDictionaryBytes: 8 * 1024 ** 2 },
    });
    const zipLzmaOriginal = Uint8Array.from(atob(zipLzmaFixture.member.original.base64), (byte) => byte.charCodeAt(0));
    assertBytes(zipLzmaRead.bytes, zipLzmaOriginal);
    if (
      zipLzmaRead.integrity !== "checksum-verified" || zipLzmaRead.codec?.kind !== "lzma" ||
      zipLzmaRead.codec.integrity !== "none" || zipLzmaRead.codec.termination !== "end-marker"
    ) throw new Error("Packed ZIP LZMA verification changed");
    for (
      const item of [
        {
          archive: zipBzip,
          name: zipBzipFixture.member.name,
          original: Uint8Array.from(atob(zipBzipFixture.member.original.base64), (byte) => byte.charCodeAt(0)),
          policy: { bzip: { maxSteps: 256 * 1024 ** 2 } },
        },
        {
          archive: zipLzma,
          name: zipLzmaFixture.member.name,
          original: zipLzmaOriginal,
          policy: { lzma: { maxDictionaryBytes: 8 * 1024 ** 2 } },
        },
      ]
    ) {
      const files = createFileSystem(createZipAdapter(item.archive, { ...item.policy, maxOutputBytes: 64 }));
      try {
        assertBytes(await files.readFile("/" + item.name), item.original);
      } finally {
        await files.close();
      }
      assertBytes(
        (await item.archive.read(item.archive.entries.find((entry) => entry.name === item.name).id)).bytes,
        item.original,
      );
    }
  });
  it("streaming ZIP member verification", async () => {
    const zipBytes = new Uint8Array(
      await new Response(createZipStream([
        { name: "payload.bin", size: archivePayload.length, source: archivePayload },
        { name: "empty/", kind: "directory" },
      ])).arrayBuffer(),
    );
    const zip = await openZip(createByteSource(zipBytes));
    const zipRead = await zip.read(0);
    assertBytes(zipRead.bytes, archivePayload);
    if (zip.entries.length !== 2 || zipRead.integrity !== "checksum-verified") {
      throw new Error("Packed streaming ZIP verification mismatch");
    }
  });
});
