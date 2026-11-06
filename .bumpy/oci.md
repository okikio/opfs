---
"@okikio/opfs": minor
---

### Verify registry content before composing an archive source

The optional oci subpath reads manifests, blobs and tag pages from an explicit registry/repository. Exact manifest bytes
are SHA256-verified before parsing. A blob becomes an immutable byte source only after a bounded full download and hash
check; partial streamed ranges remain explicitly server-trusted.

```ts
import { OciClient } from "@okikio/opfs/oci";

const registry = new OciClient({
  registry: "https://registry.example/",
  repository: "team/artifact",
  headers: () => ({ authorization: "Bearer replace-with-your-registry-token" }),
});
const manifest = await registry.getManifest("release");
console.log(manifest.digest); // SHA-256 of this response's exact bytes; release can move later.
if (manifest.kind !== "manifest" || manifest.layers?.[0] === undefined) {
  throw new Error("Select a manifest with an appropriate blob descriptor first.");
}
const descriptor = manifest.layers[0];
const source = await registry.openBlobSource(descriptor.digest, {
  size: descriptor.size,
  maxBytes: 16 * 1024 * 1024,
});
console.log(source.stability); // immutable: the complete blob has already been fetched and verified.
console.log(await source.read(0, Math.min(source.size, 64)));
```

Registry credentials are caller-owned and are never forwarded through blob redirects. Optional exact-origin redirect
allowlists admit credential-free followups. No Docker credential discovery, token challenge negotiation, image
filesystem extraction, signature verification, pushes or referrers API is claimed. A pinned real Distribution registry
verifies the pull profile, while authored fixtures test corrupt receipts and credential isolation. Native WebCrypto
hashes whole bounded materialized values; it does not supply streaming digest verification.

See [the complete ownership and protocol guide](docs/oci.md).
