---
"@okikio/opfs": minor
---

Read logical version states from an explicit OCFL1.1 object inventory and verify exact selected content. Inventory and
content fixity remain separate from supplied-file coverage and authenticity.

```ts
import { openOcfl } from "@okikio/opfs/archive/ocfl";
import { createBlobSource } from "@okikio/opfs/source";

export async function inspectObject(subtle: Pick<SubtleCrypto, "digest">) {
  const encoder = new TextEncoder();
  const content = encoder.encode("preserved\n");
  const digest = async (bytes: Uint8Array) =>
    Array.from(
      new Uint8Array(await subtle.digest("SHA-256", new Uint8Array(bytes).buffer)),
      (byte) => byte.toString(16).padStart(2, "0"),
    ).join("");
  const checksum = await digest(content);
  const inventory = encoder.encode(JSON.stringify({
    id: "urn:example:preserved",
    type: "https://ocfl.io/1.1/spec/#inventory",
    digestAlgorithm: "sha256",
    head: "v1",
    manifest: { [checksum]: ["v1/content/note.txt"] },
    versions: {
      v1: { created: "2026-01-01T00:00:00Z", state: { [checksum]: ["notes/readme.txt"] } },
    },
  }));
  const file = (path: string, bytes: Uint8Array) => ({
    path,
    source: createBlobSource(new Blob([new Uint8Array(bytes).buffer])),
  });
  const view = await openOcfl([
    file("0=ocfl_object_1.1", encoder.encode("ocfl_object_1.1\n")),
    file("inventory.json", inventory),
    file("inventory.json.sha256", encoder.encode(`${await digest(inventory)} inventory.json\n`)),
    file("v1/inventory.json", inventory),
    file("v1/content/note.txt", content),
  ]);
  const entry = view.entries("v1")[0]!;
  const inventoryEvidence = await view.verifyInventory({ subtle });
  const contentEvidence = await view.verifyContent("v1", entry.path, { subtle });
  const preview = await view.read("v1", entry.path);
  return { entry, inventoryEvidence, contentEvidence, preview, coverage: view.coverage };
}
```

See the [ocfl guide](../docs/ocfl.md) for ownership, finite limits, unsupported profiles and recovery.
