import { bench, do_not_optimize } from "mitata";
import { decodeBase64 } from "@std/encoding/base64";
import { openCryptomator } from "../src/crypto/cryptomator.ts";
import { createBlobSource } from "../src/source.ts";
import { openZip } from "../src/archive/zip.ts";
import { expectBytes, finish, report } from "./result.ts";
import receipt from "../tests/fixtures/cryptomator/independent.json" with { type: "json" };

// Question: what are the key-opening, complete-covering-chunk and nested archive
// costs for these fixed originals? The native lane has preselected keys/extents;
// it omits configuration/header parsing, SIV and aggregate admission.
const item = receipt.fixtures.find((value) => value.id === "length-100003");
const nested = receipt.fixtures.find((value) => value.id === "nested-zip");
const named = receipt.fixtures.find((value) => value.id === "unicode");
if (!item || !nested || !named) throw new Error("Cryptomator benchmark fixtures are absent.");
const key = decodeBase64(receipt.key), config = new TextEncoder().encode(receipt.configuration);
const original = decodeBase64(item.original), cipher = decodeBase64(item.ciphertext);
const source = createBlobSource(new Blob([new Uint8Array(cipher).buffer]));
// Sampling is finite and has separate generous lifetime budgets. It is not a
// production policy recommendation. Exceeding a budget fails the benchmark.
const allowance = {
  maxSourceBytes: 64 * 1024 ** 3,
  maxDecodedBytes: 64 * 1024 ** 3,
  maxOutputBytes: 16 * 1024 ** 3,
  maxRequests: 10_000_000,
};
const cleanups: Array<() => PromiseLike<void>> = [];
let primary: readonly unknown[] = [];
try {
  const vault = await openCryptomator(config, key, {
    ...allowance,
    maxNativeCalls: 1_000_000,
    subtle: globalThis.crypto.subtle,
  });
  cleanups.push(() => vault[Symbol.asyncDispose]());
  const file = await vault.open(source, allowance);
  cleanups.push(() => file[Symbol.asyncDispose]());
  expectBytes(await file.read(0, original.length), original, "cryptomator/full-original");
  const full = await file.readVerified(0, original.length);
  const prefix = await file.readVerified(0, 37);
  const cross = await file.readVerified(32767, 3);
  expectBytes(prefix.bytes, original.subarray(0, 37), "cryptomator/prefix");
  expectBytes(cross.bytes, original.subarray(32767, 32770), "cryptomator/cross-chunk");
  if (prefix.work.sourceBytes !== 32796 || prefix.work.decodedBytes !== 32768 || cross.chunks !== 2) {
    throw new Error("Cryptomator covering-chunk work scope changed.");
  }
  const master = await globalThis.crypto.subtle.importKey("raw", key.subarray(0, 32), "AES-GCM", false, ["decrypt"]);
  const header = new Uint8Array(
    await globalThis.crypto.subtle.decrypt({ name: "AES-GCM", iv: cipher.slice(0, 12) }, master, cipher.slice(12, 68)),
  );
  const content = await globalThis.crypto.subtle.importKey("raw", header.slice(8), "AES-GCM", false, ["decrypt"]);
  header.fill(0);
  const aad = new Uint8Array(20);
  aad.set(cipher.subarray(0, 12), 8);
  const native = async () => {
    const bytes = await source.read(68, 32796);
    return new Uint8Array(
      await globalThis.crypto.subtle.decrypt(
        { name: "AES-GCM", iv: bytes.slice(0, 12), additionalData: aad },
        content,
        bytes.slice(12),
      ),
    );
  };
  expectBytes(await native(), original.subarray(0, 32768), "cryptomator/native-preselected-chunk");
  bench(
    "cryptomator native preselected chunk source=32796B decoded=32768B output=32768B requests=1 GCM-calls=1",
    async () => {
      do_not_optimize(await native());
    },
  );
  bench(
    `cryptomator warm prefix source=${prefix.work.sourceBytes}B decoded=${prefix.work.decodedBytes}B output=37B requests=1 covering-auth`,
    async () => {
      do_not_optimize(await file.readVerified(0, 37));
    },
  );
  bench(
    `cryptomator warm boundary source=${cross.work.sourceBytes}B decoded=${cross.work.decodedBytes}B output=3B requests=2 covering-auth`,
    async () => {
      do_not_optimize(await file.readVerified(32767, 3));
    },
  );
  bench(
    `cryptomator warm full source=${full.work.sourceBytes}B decoded=${full.work.decodedBytes}B output=${original.length}B requests=4 present-chunks-auth`,
    async () => {
      do_not_optimize(await file.readVerified(0, original.length));
    },
  );
  const cold = async () => {
    const owners: Array<() => PromiseLike<void>> = [];
    let reason: readonly unknown[] = [];
    try {
      const openedVault = await openCryptomator(config, key, { subtle: globalThis.crypto.subtle });
      owners.push(() => openedVault[Symbol.asyncDispose]());
      const openedFile = await openedVault.open(source);
      owners.push(() => openedFile[Symbol.asyncDispose]());
      return await openedFile.read(0, 37);
    } catch (error) {
      reason = [error];
      throw error;
    } finally {
      await finish(owners, reason);
    }
  };
  expectBytes(await cold(), original.subarray(0, 37), "cryptomator/cold");
  bench("cryptomator cold config+keys+header+prefix output=37B source=32864B requests=2", async () => {
    do_not_optimize(await cold());
  });
  if ((await vault.decryptName(named.encryptedName, named.parent)).name !== named.name) {
    throw new Error("Cryptomator independent name oracle differs.");
  }
  bench(
    `cryptomator warm authenticated SIV name utf8=${
      new TextEncoder().encode(named.name).length
    }B native-CBC=6 CTR=1 HMAC=2`,
    async () => {
      do_not_optimize(await vault.decryptName(named.encryptedName, named.parent));
    },
  );
  const nestedSource = createBlobSource(new Blob([new Uint8Array(decodeBase64(nested.ciphertext)).buffer]));
  const nestedFile = await vault.open(nestedSource, allowance);
  cleanups.push(() => nestedFile[Symbol.asyncDispose]());
  const archive = await openZip(nestedFile, allowance);
  const entry = archive.entries.find((value) => value.name === "selected.txt");
  if (!entry) throw new Error("Cryptomator nested ZIP member is absent.");
  const selected = new TextEncoder().encode("authenticated nested archive preview\n");
  expectBytes((await archive.read(entry.id)).bytes, selected, "cryptomator/nested-ZIP");
  bench(`cryptomator warm ZIP selected member output=${selected.length}B own-ZIP-CRC plus covering-GCM`, async () => {
    do_not_optimize(await archive.read(entry.id));
  });
  await report();
} catch (error) {
  primary = [error];
  throw error;
} finally {
  await finish(cleanups, primary);
}
