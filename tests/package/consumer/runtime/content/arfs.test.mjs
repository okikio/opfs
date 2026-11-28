/** Installed content arfs contracts. Each case owns its state and exact source oracle. */
import { describe, it } from "node:test";
import { createByteSource } from "@okikio/opfs/source";
import { openArfs } from "@okikio/opfs/content/arfs";
import { openZip } from "@okikio/opfs/archive/zip";
import { assertBytes } from "../../bytes.mjs";
import arfsInput from "../../data/content/arfs.json" with { type: "json" };
import arfsZipInput from "../../data/content/arfszip.json" with { type: "json" };

describe("packed content arfs", () => {
  it("ArFS supplied revisions and ZIP composition", async () => {
    const arfsFixture = arfsInput;
    /** Decode retained metadata and payload bytes without calling candidate codecs. */
    const arfsBytes = (value) => Uint8Array.from(atob(value), (byte) => byte.charCodeAt(0));
    /** Bind each supplied revision to its recorded identity; this fixture makes no chain-inclusion claim. */
    const arfsMetadata = (record) => ({
      transactionId: record.transactionId,
      owner: record.owner,
      tags: record.tags,
      source: createByteSource(arfsBytes(record.bytesBase64), { identity: "native-fixture:" + record.transactionId }),
    });
    const arfsInventory = {
      drive: arfsMetadata(arfsFixture.metadata.find((record) => record.label === "drive")),
      entities: arfsFixture.metadata.filter((record) => record.label !== "drive").map(arfsMetadata),
    };
    const arfs = await openArfs(arfsInventory);
    const arfsFile = arfs.file(arfsFixture.ids.file);
    const arfsData = {
      transactionId: arfsFixture.payload.transactionId,
      source: createByteSource(arfsBytes(arfsFixture.payload.bytesBase64), { identity: "native-data-fixture" }),
    };
    const arfsSelected = await arfsFile.read(arfsData, { offset: 6, length: 11 });
    assertBytes(arfsSelected.bytes, arfsBytes(arfsFixture.original.range.bytesBase64));
    assertBytes(await arfsFile.source(arfsData).read(0, arfsFile.size), arfsBytes(arfsFixture.original.bytesBase64));
    if (
      arfs.scope !== "supplied-selected-revisions" || arfs.integrity !== "caller-supplied-metadata" ||
      arfsSelected.integrity !== "caller-supplied-data" || arfs.list(arfsFixture.ids.root).entries.length !== 2
    ) throw new Error("Packed ArFS supplied-inventory evidence changed");
    // An authored metadata revision explicitly binds independent Python ZIP bytes.
    const arfsZip = arfsZipInput;
    const arfsZipBytes = arfsBytes(arfsZip.wireBase64), arfsZipTx = "D".repeat(42) + "A";
    const arfsZipRecord = arfsFixture.metadata.find((record) => record.label === "file");
    const arfsZipJson = { ...arfsZipRecord.expected, size: arfsZipBytes.length, dataTxId: arfsZipTx };
    const arfsZipMetadata = {
      ...arfsMetadata(arfsZipRecord),
      transactionId: "C".repeat(42) + "A",
      source: createByteSource(new TextEncoder().encode(JSON.stringify(arfsZipJson)), {
        identity: "authored-zip-metadata",
      }),
    };
    const arfsZipView = await openArfs({
      drive: arfsInventory.drive,
      entities: [
        ...arfsInventory.entities.filter((record) => record.transactionId !== arfsZipRecord.transactionId),
        arfsZipMetadata,
      ],
    });
    const arfsZipSource = arfsZipView.file(arfsFixture.ids.file).source({
      transactionId: arfsZipTx,
      source: createByteSource(arfsZipBytes, { identity: "independent-python-zip" }),
    });
    const arfsArchive = await openZip(arfsZipSource);
    assertBytes((await arfsArchive.read(0)).bytes, arfsBytes(arfsZip.originalBase64));
  });
});
