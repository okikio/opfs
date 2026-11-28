/** Installed archive preservation contracts. Each case owns its state and exact source oracle. */
import { describe, it } from "node:test";
import { createByteSource } from "@okikio/opfs/source";
import { openBagit } from "@okikio/opfs/archive/bagit";
import { openOcfl } from "@okikio/opfs/archive/ocfl";
import { assertBytes } from "../../bytes.mjs";
import bagitInput from "../../data/archive/bagit.json" with { type: "json" };
import ocflInput from "../../data/archive/ocfl.json" with { type: "json" };

describe("packed archive preservation", () => {
  it("BagIt inventory and payload digests", async () => {
    const bagitFixture = bagitInput;
    const bag = await openBagit([
      { kind: "directory", path: "data" },
      ...bagitFixture.files.map((entry) => ({
        kind: "file",
        path: entry.path,
        source: createByteSource(Uint8Array.from(atob(entry.base64), (byte) => byte.charCodeAt(0))),
      })),
    ]);
    if (bag.coverage.issues.length) throw new Error("Packed BagIt coverage differs from independent inventory");
    const bagManifest = bag.manifests.find((manifest) =>
      manifest.kind === "payload" && manifest.algorithm === "sha512"
    );
    if (
      (await bag.verify(bagManifest.id, "data/binary.bin", { subtle: globalThis.crypto.subtle })).integrity !==
        "manifest-digest"
    ) throw new Error("Packed BagIt digest failed");
    assertBytes(await bag.source("data/binary.bin").read(0, 5), new Uint8Array([0, 1, 2, 3, 255]));
  });
  it("OCFL inventory and selected-content proofs", async () => {
    const ocflFixture = ocflInput;
    const ocfl = await openOcfl(
      ocflFixture.files.map((entry) => ({
        path: entry.path,
        source: createByteSource(Uint8Array.from(atob(entry.base64), (byte) => byte.charCodeAt(0))),
      })),
    );
    if ((await ocfl.verifyInventory({ subtle: globalThis.crypto.subtle })).scope !== "inventory-digest") {
      throw new Error("Packed OCFL inventory proof changed");
    }
    if ((await ocfl.verifyContent("v1", "binary", { subtle: globalThis.crypto.subtle })).scope !== "selected-content") {
      throw new Error("Packed OCFL content proof changed");
    }
  });
});
