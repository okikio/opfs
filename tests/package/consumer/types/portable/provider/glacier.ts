/** Compile-only installed provider glacier contracts; never execute these expressions. */
import { createGlacierClient } from "@okikio/opfs/glacier";

const glacierNative = createGlacierClient({
  endpoint: "https://glacier.invalid",
  account: "-",
  vault: "types",
  region: "us-east-1",
  credentials: { accessKeyId: "fixture", secretAccessKey: "fixture" },
  fetch: async () => {
    throw new Error("type-only");
  },
  subtle: globalThis.crypto.subtle,
  now: () => new Date(),
});
const glacierReceiptTyped: import("@okikio/opfs/glacier").GlacierReceiptType = await glacierNative.startArchiveJob(
  "archive",
  { start: 0, end: 1048575, archiveSize: 1048576, tier: "Bulk" },
);
const glacierUploadTyped: import("@okikio/opfs/glacier").GlacierUploadType = await glacierNative.createUpload(1048576);
const glacierPartTyped: import("@okikio/opfs/glacier").GlacierPartType = await glacierNative.uploadPart(
  glacierUploadTyped,
  0,
  new Uint8Array([1]),
);
const glacierListedTyped: import("@okikio/opfs/glacier").GlacierPartsType = await glacierNative.listPartsPage(
  glacierUploadTyped,
  { limit: 1 },
);
const glacierJobTyped: import("@okikio/opfs/glacier").GlacierJobType = await glacierNative.describeJob(
  glacierReceiptTyped.id,
);
const glacierOutputTyped: import("@okikio/opfs/glacier").GlacierOutputSourceType = await glacierNative.openOutput(
  glacierReceiptTyped.id,
);
const glacierReadTyped: Uint8Array =
  (await glacierNative.readOutput(glacierJobTyped, 0, 1, { expectedTreeHash: "a".repeat(64) })).bytes;
const glacierCompleteTyped: import("@okikio/opfs/glacier").GlacierReceiptType = await glacierNative.completeUpload(
  glacierUploadTyped,
  [glacierPartTyped],
  1,
);
const glacierVaultTyped: import("@okikio/opfs/glacier").GlacierVaultType = await glacierNative.describeVault();
// @ts-expect-error Glacier's native client does not implement an OPFS object driver contract.
const glacierObjectDriver: import("@okikio/opfs/driver/object").ObjectBackendType = glacierNative;
const glacierWrongHash: import("@okikio/opfs/glacier").GlacierPartType = {
  start: 0,
  end: 0,
  // @ts-expect-error Native tree hashes are textual digests, not mutable byte buffers.
  treeHash: new Uint8Array(32),
};
void glacierListedTyped;
void glacierOutputTyped.archiveOffset;
void glacierReadTyped;
void glacierCompleteTyped;
void glacierVaultTyped;
void glacierObjectDriver;
void glacierWrongHash;
