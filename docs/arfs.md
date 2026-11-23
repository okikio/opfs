# Inspect selected public ArFS revisions

ArFS stores logical drive, folder and file metadata in Arweave transactions. A file's metadata points to a separate
transaction containing its data. A later rename can retain the same logical file UUID while using a new metadata
transaction ID. This reader inspects a caller-selected inventory; it does not decide which revisions are current.

Supply already decoded tags and metadata sources. The following function returns selected file bytes without owning a
gateway, following URLs or acquiring credentials:

```ts
import { createArchiveLedger, openArfs } from "@okikio/opfs/content/arfs";
import type { ArfsDataInputType, ArfsInputType } from "@okikio/opfs/content/arfs";

export async function preview(
  inventory: ArfsInputType,
  fileId: string,
  downloaded: ArfsDataInputType,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  const ledger = createArchiveLedger({
    maxSourceBytes: 32 * 1024 * 1024,
    maxRequests: 1024,
    maxDecodedBytes: 16 * 1024 * 1024,
    maxOutputBytes: 1024 * 1024,
  });
  const view = await openArfs(inventory, {
    ledger,
    ...(signal ? { signal } : {}),
  });
  const file = view.file(fileId);
  const length = Math.min(file.size, 256);
  const result = await file.read(downloaded, { offset: 0, length });
  return result.bytes;
}
```

`inventory.drive` is one drive metadata descriptor. `inventory.entities` is a finite array of selected folder and file
metadata descriptors. Each descriptor supplies `transactionId`, `owner`, `tags: [{ name, value }]` and `source`. Sources
implement `ByteSourceType`: known size, exact addressable reads, a nonempty identity and explicit `immutable`,
`provider` or `caller` stability evidence. [Sources](source.md) explains that evidence. The caller owns and acquires
each source; the reader neither disposes it nor assumes that an ID authenticates it.

`downloaded` supplies `{ transactionId, source }` for the selected file's data. A mismatched transaction ID or size
fails before data I/O. The reader cannot establish that arbitrary caller bytes actually belong to that transaction. The
ID and owner are assertions, including when a gateway originally supplied them. Signature verification, Arweave
data-root verification, consensus inclusion, confirmation and gateway authenticity are separate missing proof here.

## Read a selected archive

`file.source(downloaded)` returns a borrowed logical source for composition with an archive reader. It validates the
binding without reading data, preserves the original stability evidence and names the selected metadata/data/source
identities together. It never upgrades caller evidence because an identifier looks like a transaction ID.

```ts
import { createArchiveLedger, openArfs } from "@okikio/opfs/content/arfs";
import type { ArfsDataInputType, ArfsInputType } from "@okikio/opfs/content/arfs";
import { openZip } from "@okikio/opfs/archive/zip";

export async function inspectZip(
  inventory: ArfsInputType,
  fileId: string,
  downloaded: ArfsDataInputType,
) {
  const ledger = createArchiveLedger({ maxSourceBytes: 64 * 1024 * 1024 });
  const drive = await openArfs(inventory, { ledger });
  const file = drive.file(fileId);
  const archive = await openZip(file.source(downloaded), { ledger });
  return archive.entries;
}
```

The archive and ArFS layers report their own requested work. If the same external ledger is explicitly supplied to both
layers, that ledger observes both layers' work; that is deliberate composition accounting, not a transport-byte meter.
Within ArFS, passing the same ledger through opening, `file.read` and `file.source` charges that owner once per ArFS
operation. A source callback may perform additional work or allocate internally; that foreign work is opaque.

## Revisions, names and inventory scope

The result is always `profile: "public-0.15"`, `scope: "supplied-selected-revisions"` and
`integrity: "caller-supplied-metadata"`. `file.read` returns `integrity: "caller-supplied-data"`. Neither label means
cryptographically authenticated content. Metadata work is available as `view.work`; selected ranges return their own
`work` counts for source bytes, source requests, decoded metadata and returned payload bytes.

Each logical UUID can appear once, regardless of case. Internal equality uses lowercase UUIDs; original tag values and
the full JSON text remain available. `metadataSource` retains each source's captured identity, size and stability
evidence. Duplicate metadata transaction IDs also fail. The reader never chooses a revision using `Unix-Time`: that tag
is seconds since Unix epoch and is not trustworthy ordering evidence. A file's `lastModifiedDate` is milliseconds, a
different field and unit.

`list(folderId)` includes every supplied selected child, including hidden entries, and retains the inventory's scope. It
does not establish that other children do not exist. Missing selected parents or the selected root produce `issues`; a
parent selecting a file, a mismatched drive/metadata owner, an inconsistent supplied root or a supplied cycle fails.
Traversal is bounded by the admitted inventory and never fetches a missing reference.

Names are literal display metadata. Slashes, `..`, duplicate display names and URL-looking text do not acquire path
semantics. File selection uses UUIDs. No host filesystem projection, HTML rendering, ArNS lookup or URL fetching occurs.
Unknown tags can repeat and remain inert; unknown JSON remains in `metadataJson`. Returned metadata, tags, inventories
and issue arrays are owned immutable copies.

A public file pin can name data from another owner. `pinnedDataOwner` is retained as an assertion; data owner equality
with the drive owner is not required. An explicitly supplied `Pinned-Data-Tx` tag must match `dataTxId`. Pins do not
cause downloads, and custom URLs or assigned-name hints never become trusted locators.

## Admission and work limits

Opening captures the descriptor inventory, decoded tags and source methods before its first asynchronous read. UTF16
strings are bounded before UTF8 encoding, and unpaired surrogates fail. Metadata requires strict UTF8 JSON without a
BOM. A bounded lexical pass rejects duplicate decoded JSON keys, including escaped spellings, before `JSON.parse` could
discard earlier authority. Reserved `__proto__` keys fail. Required authority fields are checked with executable
schemas. For file entities, direct root `size` and `lastModifiedDate` tokens must use nonnegative decimal integer
notation within the safe integer range; fractions, exponents and negative zero fail before binary64 rounding. This
narrower selected writer profile does not restrict numeric notation inside inert custom metadata, including those field
names on drive/folder entities. Singular authority tags fail on duplication even if both values are equal.

These are local reader policies, not Arweave protocol maxima:

| Option                                    | Default | Hard ceiling |
| ----------------------------------------- | ------: | -----------: |
| `maxMetadataBytes`, one metadata source   |   1 MiB |        4 MiB |
| `maxTotalMetadataBytes`, all raw metadata |  16 MiB |       64 MiB |
| `maxEntities`, excluding drive            |   10000 |        65536 |
| `maxIndexBytes`, retained estimate        |  16 MiB |       64 MiB |
| `maxTags`, per entity                     |      64 |          256 |
| `maxTagBytes`, each tag name/value        |    4096 |        65536 |
| `maxTagTotalBytes`, all tag bytes/entity  |   16384 |        65536 |
| `maxNameBytes`, literal UTF8 name         |    4096 |        65536 |
| `maxJsonDepth`                            |      16 |           64 |
| `maxJsonTokens`, values and keys/document |  100000 |      1000000 |

The index estimate includes four times raw metadata bytes, twice decoded tag bytes, per-tag overhead, source identity
text and per-record index overhead. It is an admission estimate, not an exact JavaScript heap measurement. Independent
policies can bind before another policy's advertised maximum. Metadata JSON string values cannot exceed
`maxMetadataBytes`.

All known metadata source bytes, requests and decoded-byte work are reserved before the first source callback.
Collection reads at most 64 KiB per request. Selected file data is deferred; reads reserve source/request/output work
before their returned array is allocated. One payload read has a hard 16 MiB output ceiling. Empty reads do no source
I/O, and invalid offsets are never silently clamped. No sibling file data is read.

The ordinary `ArchiveLimitsType` options supply source, request, decoded and output limits. Opening creates a lifetime
ledger as well as retaining any caller ledger; later calls create narrower operation ledgers. These owners remain
attached to every `file.source` read. Raising a child limit cannot defeat a parent limit. Failed admitted work remains
charged, so retrying does not reset lifetime authority.

Opening, source-view and operation abort signals compose. Passing a fresh signal to a later read cannot override an
aborted opening or view. Checks before and after each borrowed callback prevent post-abort data release; a callback that
ignores cancellation must still retire before its awaiting read settles. No background task is started.

## Deliberate profile limits

The pinned ArFS specification requires general readers to accept versions 0.10 through 0.15. This first selected profile
supports **public 0.15 drive/folder/file metadata only**, not general ArFS reader conformance. Historical versions,
encrypted metadata, wallet/key derivation, AES-GCM/CTR, snapshots, drive-state databases, publications, GraphQL
discovery, automatic revision choice, writes and a native Arweave client remain separate pending work. Private or
cipher-tagged records fail rather than being treated as public bytes. Unknown entity types also fail.

Current ArDrive code defines a 12-byte CTR nonce followed by a zero 32-bit initial counter, and also accepts a 16-byte
counter form. That source evidence does not make private range previews implemented here. CTR alone has no plaintext
authentication; GCM generally requires complete bounded ciphertext verification before plaintext can be released. Those
protocols need their own explicit key and integrity contracts.

## Sources and evidence

The format research uses these immutable primary sources:

- [ArDrive web ArweaveFS specification, commit 5e1a81e](https://github.com/ardriveapp/ardrive-web/blob/5e1a81e7d5229e540da7fc6b144f455a812e8a2e/docs/ArweaveFS.md).
- [ar.io ArFS documentation, commit 38bc05c](https://github.com/ar-io/docs/tree/38bc05ce5684c9faa2af0d0f22a60c0f2c178347/content/build/advanced/arfs).
- [ArDrive core 5.1.1 transaction data, commit 54a3b4c](https://github.com/ardriveapp/ardrive-core-js/blob/54a3b4c3e9e1d03d76bfb1fec9fada1193745f22/src/arfs/tx/arfs_tx_data_types.ts).
- [ArDrive current cipher interpretation at the same pin](https://github.com/ardriveapp/ardrive-core-js/blob/54a3b4c3e9e1d03d76bfb1fec9fada1193745f22/src/utils/crypto.ts).

The test-only independent producer retained genuine ArDrive core 5.1.1 drive/root/folder/file/pin metadata and Arweave
1.15.7 locally signed transaction bytes. Every native builder accepted its exact metadata bytes, native transaction
signature checks passed, and selected full/range file bytes matched independently authored originals. The producer ran
offline with zero monitored network calls; no transaction was submitted or funded. Authored adversarial regressions and
a separate Python ZIP producer/consumer prove additional rejection and composition behavior.
[Fixture provenance and reproduction](../tests/fixtures/arfs/README.md) records artifact/source/lock hashes and resource
bounds. These tool results do not establish publication, confirmation or signature/data-root verification by this
production reader.

## Benchmark workload

`bench/arfs.bench.ts` checks complete native-fixture originals and the selected range before timing four in-memory
workloads. It compares an explicitly borrowed Blob-source range lower bound with selected-file admission, opens the five
metadata records cold, and lists the two supplied root children. It does not time the SDK, signing, network access or
chain verification. Warm sampling has a finite 64 GiB/10-million-request lifetime allowance; cold samples create fresh
default ledgers.

One Node 26.13.0 ARM64 macOS/M1 Pro run measured median 1.917 microseconds for the borrowed 11-byte range, 3.964
microseconds for the selected-file range, 79.750 microseconds for cold admission of 660 metadata bytes/five source
requests, and 0.377 microseconds for listing four indexed entities/two results. These fixture-specific observations are
not universal throughput or SDK performance comparisons. The raw Mitata distributions remain in the local compressed
implementation receipt; rerun the workload on the consumer's runtime and data before drawing performance conclusions.
