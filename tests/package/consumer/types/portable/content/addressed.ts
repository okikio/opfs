/** Compile-only installed content addressed contracts; never execute these expressions. */
import { openUnixfs } from "@okikio/opfs/content/unixfs";
import { verifyArweaveTransaction } from "@okikio/opfs/content/arweave";
import { createArweaveClient } from "@okikio/opfs/arweave";
import { createByteSource } from "@okikio/opfs/source";
import { parseCid, verifyBlock } from "@okikio/opfs/content/cid";

const unixfs: import("@okikio/opfs/content/unixfs").UnixfsNodeType = await openUnixfs(
  "cid",
  async () => new Uint8Array(),
  { subtle: globalThis.crypto.subtle },
);
if (unixfs.kind === "file") {
  const range: import("@okikio/opfs/content/unixfs").UnixfsReadType = await unixfs.read({ offset: 0, length: 0 });
  const verification: import("@okikio/opfs/content/unixfs").UnixfsVerificationType = await unixfs.verify();
  void [range, verification, unixfs.source()];
}
if (unixfs.kind === "hamt-directory") {
  const hamt: import("@okikio/opfs/content/unixfs").UnixfsHamtType = unixfs;
  const listing: import("@okikio/opfs/content/unixfs").UnixfsListingType = await hamt.list();
  void [listing, hamt.profile];
}
const arweaveTransaction: import("@okikio/opfs/content/arweave").ArweaveTransactionType =
  await verifyArweaveTransaction(new Uint8Array(), {
    expectedId: "type-only",
    profile: "rsa4096-pss32-v2",
    subtle: globalThis.crypto.subtle,
  });
const arweaveData: import("@okikio/opfs/content/arweave").ArweaveDataType = await arweaveTransaction.verifyData(
  createByteSource(new Uint8Array()),
  { chunkProfile: "arweave-js-1.15.7" },
);
const arweaveClient: import("@okikio/opfs/arweave").ArweaveClientType = createArweaveClient({
  url: "https://arweave.example",
  fetch,
  subtle: globalThis.crypto.subtle,
  profile: "rsa4096-pss32-v2",
});
const arweaveRemote: import("@okikio/opfs/arweave").ArweaveRemoteTransactionType = await arweaveClient.open(
  "type-only",
);
void arweaveData;
void arweaveRemote;
const cid = parseCid("f015512202cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824");
await verifyBlock(cid.id, new TextEncoder().encode("hello"));
