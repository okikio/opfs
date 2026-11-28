/** Compile-only installed crypto contracts; never execute these expressions. */
import { JweProtectedSchema, openJwe } from "@okikio/opfs/crypto/jwe";
import { openAge } from "@okikio/opfs/crypto/age";
import { createNodeAgeAead } from "@okikio/opfs/crypto/age-node";
import { openCryptomator } from "@okikio/opfs/crypto/cryptomator";
import { createByteSource } from "@okikio/opfs/source";

const jweOptionsTyped: import("@okikio/opfs/crypto/jwe").JweOpenOptionsType = {
  profile: "jwe-compact-dir-a256gcm",
  key: new Uint8Array(32),
  subtle: crypto.subtle,
};
const jweTyped: import("@okikio/opfs/crypto/jwe").JweOpenedType = await openJwe(
  createByteSource(new Uint8Array()),
  jweOptionsTyped,
);
const jweSourceTyped: import("@okikio/opfs/crypto/jwe").JweSourceType = jweTyped.source;
const jweReadTyped: import("@okikio/opfs/crypto/jwe").JweReadType = await jweTyped.read(0, 0);
const jweIntegrityTyped: "whole-jwe-message-authenticated" = jweReadTyped.integrity;
jweTyped.dispose();
const ageAeadTyped: import("@okikio/opfs/crypto/age").AgeAeadType = createNodeAgeAead({
  createDecipheriv() {
    throw new Error("type-only");
  },
});
const ageTyped: import("@okikio/opfs/crypto/age").AgeOpenedType = await openAge(createByteSource(new Uint8Array()), {
  profile: "age-v1-file-key",
  fileKey: new Uint8Array(16),
  subtle: globalThis.crypto.subtle,
  aead: ageAeadTyped,
});
const ageReadTyped: import("@okikio/opfs/crypto/age").AgeReadType = await ageTyped.read(0, 1);
void ageReadTyped;
void jweSourceTyped;
void jweIntegrityTyped;
void JweProtectedSchema;
const cryptomatorTyped: import("@okikio/opfs/crypto/cryptomator").CryptomatorVaultType = await openCryptomator(
  new Uint8Array(),
  new Uint8Array(),
  { subtle: globalThis.crypto.subtle },
);
const cryptomatorSource: import("@okikio/opfs/crypto/cryptomator").CryptomatorSourceType = await cryptomatorTyped.open(
  createByteSource(new Uint8Array()),
);
const cryptomatorRead: import("@okikio/opfs/crypto/cryptomator").CryptomatorReadType = await cryptomatorSource
  .readVerified(0, 1);
await cryptomatorSource[Symbol.asyncDispose]();
await cryptomatorTyped[Symbol.asyncDispose]();
void cryptomatorRead;
