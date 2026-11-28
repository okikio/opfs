/** Installed content addressed contracts. Each case owns its state and exact source oracle. */
import { describe, it } from "node:test";
import { createByteSource } from "@okikio/opfs/source";
import { openUnixfs } from "@okikio/opfs/content/unixfs";
import { verifyArweaveTransaction } from "@okikio/opfs/content/arweave";
import { createArweaveClient } from "@okikio/opfs/arweave";
import { parseCid, verifyBlock } from "@okikio/opfs/content/cid";
import { assertBytes } from "../../bytes.mjs";
import arweaveInput from "../../data/content/arweave.json" with { type: "json" };
import unixfsInput from "../../data/content/unixfs.json" with { type: "json" };
import hamtInput from "../../data/content/hamt.json" with { type: "json" };

describe("packed content addressed", () => {
  it("CID block verification", async () => {
    const helloCid = parseCid("f015512202cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824");
    await verifyBlock(helloCid.id, new TextEncoder().encode("hello"));
  });
  it("Arweave transaction and complete data proofs", async () => {
    const arweaveFixture = arweaveInput;
    const arweaveHeader = new TextEncoder().encode(JSON.stringify(arweaveFixture.signed));
    const arweaveBytes = Uint8Array.of(17);
    // Independent producer byte[i]=(i*131+17)%251, size=1.
    const arweaveTransaction = await verifyArweaveTransaction(arweaveHeader, {
      expectedId: arweaveFixture.signed.id,
      expectedOwner: arweaveFixture.ownerAddress,
      profile: "rsa4096-pss32-v2",
      subtle: globalThis.crypto.subtle,
    });
    const arweaveData = await arweaveTransaction.verifyData(createByteSource(arweaveBytes), {
      chunkProfile: "arweave-js-1.15.7",
    });
    assertBytes(await arweaveData.source.read(0, 1), arweaveBytes);
    if (
      arweaveData.integrity !== "rsa-signature-and-data-root" || arweaveData.chain !== "not-checked" ||
      arweaveTransaction.data !== "not-checked" || arweaveData.source.stability !== "immutable"
    ) throw new Error("Packed Arweave proof scopes changed");
    let arweaveCalls = 0;
    const arweave = createArweaveClient({
      url: "https://arweave.example",
      profile: "rsa4096-pss32-v2",
      subtle: globalThis.crypto.subtle,
      fetch: async (input, init) => {
        const url = new URL(String(input));
        if (
          url.origin !== "https://arweave.example" || init?.credentials !== "omit" || init?.redirect !== "manual"
        ) throw new Error("Packed Arweave authority changed");
        const expectedPath = arweaveCalls++ === 0 ? "/tx/" + arweaveFixture.signed.id : "/" + arweaveFixture.signed.id;
        if (url.pathname !== expectedPath) throw new Error("Packed Arweave native route changed");
        const bytes = url.pathname.startsWith("/tx/") ? arweaveHeader : arweaveBytes;
        return new Response(bytes, { headers: { "content-length": String(bytes.length) } });
      },
    });
    const arweaveRemote = await arweave.open(arweaveFixture.signed.id);
    const arweaveDownloaded = await arweaveRemote.read({ chunkProfile: "arweave-js-1.15.7" });
    assertBytes(await arweaveDownloaded.source.read(0, 1), arweaveBytes);
    if (arweaveCalls !== 2 || Object.hasOwn(arweaveRemote.transaction, "verifyData")) {
      throw new Error("Packed Arweave ownership boundary changed");
    }
  });
  it("UnixFS selected blocks and complete-file proof", async () => {
    const unixfsFixture = unixfsInput;
    const unixfsBlocks = new Map(
      unixfsFixture.blocks.map((
        entry,
      ) => [entry.cid, Uint8Array.from(atob(entry.base64), (byte) => byte.charCodeAt(0))]),
    );
    const unixfsRoot = await openUnixfs(unixfsFixture.cid, async (cid) => {
      const block = unixfsBlocks.get(cid);
      if (!block) throw new Error("Packed UnixFS selected block absent");
      return block;
    }, { subtle: globalThis.crypto.subtle });
    if (unixfsRoot.kind !== "directory") throw new Error("Packed UnixFS root kind changed");
    const unixfsDirectory = await unixfsRoot.open("nested");
    if (unixfsDirectory.kind !== "directory") throw new Error("Packed UnixFS nested directory changed");
    const unixfsFile = await unixfsDirectory.open("data.bin");
    if (unixfsFile.kind !== "file") throw new Error("Packed UnixFS selected file changed");
    const unixfsOriginal = Uint8Array.from(atob(unixfsFixture.file.base64), (byte) => byte.charCodeAt(0));
    assertBytes((await unixfsFile.read()).bytes, unixfsOriginal);
    assertBytes(await unixfsFile.source().read(173, 257), unixfsOriginal.subarray(173, 430));
    if ((await unixfsFile.verify()).scope !== "complete-file") {
      throw new Error("Packed UnixFS verification scope changed");
    }
  });
  it("Kubo HAMT admission, inventory and selected files", async () => {
    const hamtFixture = hamtInput;
    const hamtBlocks = new Map(
      hamtFixture.blocks.map((entry) => [entry.cid, Uint8Array.from(atob(entry.base64), (byte) => byte.charCodeAt(0))]),
    );
    /** Expose only captured blocks; an unrecorded traversal must fail rather than fetch a replacement. */
    const hamtReader = async (cid) => {
      const bytes = hamtBlocks.get(cid);
      if (!bytes) throw new Error("Packed HAMT block absent");
      return bytes;
    };
    let hamtDefaultRefused = false;
    try {
      await openUnixfs(hamtFixture.rootCid, hamtReader, { subtle: globalThis.crypto.subtle });
    } catch (error) {
      hamtDefaultRefused = error.message.includes("hamtProfile");
    }
    if (!hamtDefaultRefused) throw new Error("Packed HAMT default admission changed");
    const hamt = await openUnixfs(hamtFixture.rootCid, hamtReader, {
      subtle: globalThis.crypto.subtle,
      hamtProfile: "kubo-fanout-256",
    });
    if (hamt.kind !== "hamt-directory" || hamt.profile !== "kubo-fanout-256") {
      throw new Error("Packed HAMT profile changed");
    }
    const inventory = await hamt.list();
    if (
      inventory.scope !== "complete-directory-links" ||
      JSON.stringify(inventory.entries.map((entry) => entry.name).sort()) !== JSON.stringify(hamtFixture.names)
    ) throw new Error("Packed HAMT listing scope changed");
    const hamtFile = await hamt.open(hamtFixture.file.path);
    if (hamtFile.kind !== "file") throw new Error("Packed HAMT selected file changed");
    assertBytes(
      (await hamtFile.read()).bytes,
      Uint8Array.from(atob(hamtFixture.file.base64), (byte) => byte.charCodeAt(0)),
    );
  });
});
