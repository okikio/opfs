# Storage expansion status

This page is for contributors continuing the storage expansion. Public exports and executable tests are the authority
for implemented behavior. A provider name in a research catalog is not a support claim. Keep work on the consolidated
branch and existing PR until the maintainer decides to merge it; this work does not delete historical branches.

A representative supported flow uploads a ZIP to a disposable GCS-compatible server, binds reads to its generation,
lists its directory, and reads one member through a read-only filesystem view. The caller owns credentials, transfer
checkpoint persistence, key policy and preview rendering. A changed generation fails instead of mixing object versions.
For encrypted content, the optional Tink payload source authenticates complete covering segments before returning
plaintext. Encrypted upload restart remains a separate, unimplemented contract.

| Planned area           | Current implementation and next boundary                                                                                                                                                                                                                                                                                                             |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Sources and extensions | Exact replayable byte sources, shared request/byte budgets, revision binding, read-only adapters and an optional source conformance suite. See [sources](source.md) and [extensions](extensions.md).                                                                                                                                                 |
| GCS                    | Native JSON client, object driver/adapter, resumable upload operations and transfer destination. See [GCS](gcs.md). Emulator tests do not establish live IAM, CORS or durability behavior.                                                                                                                                                           |
| Transfer               | tus core 1.0 and explicit checkpoint/reconciliation copying; fresh-process recovery has an independent persisted-byte oracle. See [transfer](transfer.md). S3 multipart/Azure block durable restart is still pending.                                                                                                                                |
| Archive preview        | Bounded ZIP/ZIP64 stored/DEFLATE reads and a read-only ZIP view; ustar/PAX/GNU metadata reads; sequential TAR scanning and TAR/PAX plus STORED ZIP32 writers. See [archives](archive.md), [TAR](tar.md) and [ZIP creation](zip.md). Sparse TAR, encrypted ZIP, 7z, RAR and additional codecs remain pending.                                         |
| Encryption             | One optional raw Tink AES-GCM-HKDF SHA256 payload profile with authenticated range reads and explicit full verification. See [encryption](encryption.md). Official producer fixtures are interoperability evidence, not a security audit. Password KDFs, age, vaults and encrypted-write restart remain pending.                                     |
| Other HTTP storage     | [HTTP](http.md) revision-bound single-resource reads; [WebDAV](webdav.md) file client/driver/adapter (generic removal refused); native [B2](b2.md) and [Swift](swift.md) object clients/drivers/adapters. WebDAV and Swift have disposable real-server fixtures; B2 has protocol-fixture proof only. Additional S3 provider profiles remain pending. |
| Drives and databases   | Additional drive APIs and database adapters remain pending. Reuse existing file/object/record families only when their semantics fit.                                                                                                                                                                                                                |
| Decentralized storage  | IPFS, gateways, content addressing and other Web3-specific integrations remain pending. Mutable names, pinning and payment are separate capabilities.                                                                                                                                                                                                |
| Specialized formats    | Additional archive/encryption records require individual routing, independent fixtures, limits and dependency decisions before support can be claimed.                                                                                                                                                                                               |
| Release evidence       | Serial static gates, portable runtimes, disposable providers, installed package consumers and browser/Worker gates remain required for each release. Benchmark timings describe their recorded workloads only.                                                                                                                                       |

## How to continue

Add each protocol as an import-safe subpath: client → driver → adapter → filesystem → real consumer bridge. Keep
protocol messages in the client, storage mechanics in the driver and canonical filesystem translation in the adapter.
Third-party implementations use the same public contracts without registering globals. Prefer injected capabilities and
native Web APIs; selecting a new runtime dependency requires an explicit provenance and supply-chain review.

For every added capability, document a complete consumer example, exact unsupported behavior, resource ownership,
bounded allocations, cancellation and recovery. Test against an independent producer or provider as well as malformed
and interrupted operations. A fake HTTP response proves message handling; a container proves only the exercised server
behavior. Live-service claims require separately authorized live-service evidence.

The original research handoff counted 895 catalog records and 136 focused archive/encryption profiles. Those are
discovery inventories, not additive integration counts. The complete
[versioned research handoff](https://github.com/okikio/opfs/blob/b3ed2f7092264e1a5d86358a10bd1f00386466bf/planning/storage/README.md)
preserves every catalog ID, route and format record in a fresh clone. Its historical proposals remain distinct from the
implemented capabilities on this page.
