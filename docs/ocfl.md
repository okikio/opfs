# Inspect an OCFL object and read a version's files

OCFL preserves logical file states across immutable versions. Its inventory maps each logical name to a content digest,
then maps that digest to one or more physical content paths. `openOcfl()` inspects that mapping over an explicit array
of caller-supplied byte sources. It never discovers a host directory, follows links, fetches URLs or changes an object.

This example supplies a complete small object without a filesystem or network client. The application provides
`SubtleCrypto`; importing the module does not acquire cryptography or storage capabilities.

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

The logical name is `notes/readme.txt`; the physical source is `v1/content/note.txt`. Those names need not match.
Reading a logical name in an old version uses the root inventory's recorded state; it does not imply that the chosen
physical copy was present when that version was created. Removed files remain selectable in versions that contained
them.

## Select copies and compose readers

`entries(version)` returns logical paths, canonical lowercase digests and candidate physical `copies`, each with its
supplied source metadata when available. A single candidate is selected automatically. Multiple candidates require
`{ contentPath: "v1/content/..." }` on `source`, `read` or `verifyContent`, even if only one candidate was supplied.
OCFL manifest arrays are unordered: this reader does not invent a preferred copy, probe alternatives or retry failed
reads against a different copy. A missing chosen source fails explicitly.

`source(version, path, options)` returns an exact-range `ByteSourceType` suitable for `openZip`, `openMime` and other
readers. It captures the physical source's size, method binding, identity and stability. Both this wrapper and its
resources remain borrowed. The caller must keep the underlying storage available and preserve the source's asserted
snapshot. An identity is descriptive; it cannot by itself prove immutability. Sources without `stability` require
`allowUnverifiedSource: true`. Evidence for individual files does not establish an atomic snapshot across the object.

`read(version, path, options)` returns an entire bounded file with `integrity: "none"`. A successful separate
verification does not authenticate later reads or a mutable caller assertion. Use stable sources throughout the
operation. `source().read(offset, length, { signal })` supports selected ranges without reading the whole content file.
It enforces cumulative limits across that wrapper's reads; all wrappers and verification calls also share the opening
ledger. Failed acquisitions still consume reserved work. Empty reads do no physical I/O.

## Understand each verification result

`verifyInventory({ subtle })` hashes the exact root `inventory.json` bytes captured at opening and compares them with
the captured `inventory.json.sha256` or `.sha512` sidecar. Whitespace and JSON escape spelling matter. It never hashes a
re-serialized object. The result has `scope: "inventory-digest"`, source provenance and the algorithm/digest. The
sidecar is an untrusted checksum declaration, not a signature or authenticity proof. Cached metadata verification
consumes no new source requests but charges the complete JSON byte length as decoded verifier work on every call.

`verifyContent(version, path, { subtle, contentPath? })` reads the complete selected physical file and compares its
digest with the selected version's logical state. It returns `scope: "selected-content"`, `version`, `logicalPath`,
physical `path` and that source's provenance. It verifies neither other copies nor the object inventory sidecar.
Optional `fixity` blocks remain inspectable metadata; no implicit additional algorithms run.

Both verifiers support native SHA-256 and SHA-512 through injected `subtle.digest`. Whole-buffer verification defaults
to 1 MiB per operation and has a 16 MiB implementation ceiling through `maxVerifyBytes`. Before allocating the input
buffer, the reader admits the entire source/request/decoded budget. Verifier input is not returned and consumes zero
output bytes. WebCrypto can allocate additional internal memory. Hashing is not streaming; cancellation cannot interrupt
a running native digest, but it is checked before and after. Large-file streaming hashing is pending.

## Inventory rules and supplied-file diagnostics

The strict OCFL 1.1 profile checks the defined inventory/version/user fields, UTF8 without BOM, duplicate decoded JSON
keys, continuous version numbers and consistent padding, RFC3339 calendar dates, SHA-256/SHA-512 digest sizes, manifest
usage, unique physical paths, per-version unique logical paths, and references between state, manifest and fixity.
Case-insensitive hexadecimal digest aliases are rejected within a block. Aliases at different logical paths are valid. A
declared `contentDirectory` must be one direct-child component; otherwise it defaults to `content`. Physical paths must
remain inside a declared version's designated content directory.

Padded versions must retain the leading zero required by OCFL section 3.3: `v0001` through `v0100` is valid; `v001`
through `v100` is rejected because the final name no longer begins with `v0`. Mixed widths are rejected. Reserved
`__proto__` JSON dictionary keys are refused except as inert fixity algorithm labels, where the block is separately
validated and retained as an own property without prototype authority.

Paths are literal, case-sensitive Unicode. There is no percent decoding, Unicode normalization or case folding. This
conservative profile rejects dot/empty components, backslashes, control characters, unpaired surrogates and leading
Windows drive forms. Such rejection is a reader safety policy rather than a claim that every such name violates OCFL.
Leap-second timestamps are explicitly unsupported; no leap-second table is guessed. Object IDs and user addresses are
untrusted strings and are never dereferenced. Unknown optional fixity algorithm labels stay inert; this module is not a
full OCFL client implementing the complete core fixity algorithm set.

`coverage.scope` is `"supplied-object-files"`. Its issues report missing manifested content, supplied but unlisted
content in designated directories, missing/wrong root declaration or sidecar syntax, and missing/different head
inventory. When the head inventory is supplied, its **actual bytes** are compared with the captured root JSON;
`headInventory: "equal"` means that comparison ran. OCFL recommends version inventories, and requires the head copy to
equal the root when present. An absent head copy is distinct from a differing copy.

Historical inventories are deliberately `"unexamined"`. This reader does not prove historical inventory equivalence,
immutability of old version directories, object-ID uniqueness across storage, empty-directory/link rules, extension
conformance, historical digest migrations or the completeness of the caller's physical inventory. Other version files,
logs and extension contents are not executed or fetched. A root inventory can be usefully inspected while diagnostics
remain, but the result never claims whole-object validity, authenticity or historical conformance. ARC, BagIt and other
preservation formats have separate readers and contracts.

## Bound work and recover from failures

| Policy              | Default | Meaning                                                            |
| ------------------- | ------- | ------------------------------------------------------------------ |
| `maxFiles`          | 10000   | Supplied physical file records                                     |
| `maxVersions`       | 1000    | Retained version states                                            |
| `maxReferences`     | 100000  | Manifest/state/fixity path references and diagnostics              |
| `maxInventoryBytes` | 1 MiB   | Each parsed root or compared head inventory; hard 16 MiB           |
| `maxPathBytes`      | 8192    | Literal UTF8 path bytes, checked before encoding/splitting         |
| `maxMetadataBytes`  | 16 MiB  | Four times admitted raw metadata bytes plus path/record accounting |
| `maxJsonDepth`      | 16      | Nested JSON containers/values; hard 64                             |
| `maxJsonTokens`     | 500000  | JSON values and object member names                                |
| `maxStringBytes`    | 65536   | UTF8 bytes per decoded JSON string                                 |
| `maxChunkBytes`     | 4096    | Physical request size; admitted 1..65536                           |

The metadata estimate includes string/parse retention allowance but is not a precise JavaScript heap bound. Physical
sidecars are limited to 1024 bytes; the declaration is limited to 64. Archive source/request/decoded/output defaults are
64 MiB/4096/64 MiB/16 MiB respectively. `work` records opening work; each `read`/verification result records its
operation. Pass an explicit `createArchiveLedger()` to coordinate this view with other readers. Native source
implementations can perform extra hidden work; archive budgets count requested source extents rather than
transport-internal allocations.

Opening and operation options accept `signal`. A per-operation signal overrides the opening signal; a source wrapper
checks its captured signal and a per-read signal. No disposal or cancellation authority transfers to the reader.
`invalid-archive` identifies inconsistent admitted metadata, `unsupported-profile` identifies a refused profile,
`budget-exceeded` identifies a policy ceiling, and `checksum-mismatch` identifies a failed digest. Native source and
cryptography failures retain their original errors. Inspect coverage to decide whether to supply missing files or
request another object snapshot; never repair an inventory automatically after a checksum failure.

## Evidence and limits

The normative source was inspected from the primary
[OCFL/spec repository at immutable commit
2637866930ce26c52b50510aa91cbed9c1c4b0a4](https://github.com/OCFL/spec/tree/2637866930ce26c52b50510aa91cbed9c1c4b0a4/1.1/spec).
The exact UTF8 source bytes have these SHA-256 receipts:

| Source at that commit                                                                                                                         | SHA-256                                                            |
| --------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| [`1.1/spec/index.md`](https://github.com/OCFL/spec/blob/2637866930ce26c52b50510aa91cbed9c1c4b0a4/1.1/spec/index.md)                           | `3d02c6c68e542f471d9252cf1f02cd97e94615e3063930507fb2c33aa31d8f6e` |
| [`1.1/spec/inventory_schema.json`](https://github.com/OCFL/spec/blob/2637866930ce26c52b50510aa91cbed9c1c4b0a4/1.1/spec/inventory_schema.json) | `3f87a36951c25464824a25273e1480fd68448668f05ee7fa5af0115716b0b82c` |

The specification source identifies itself as OCFL1.1, 7 October 2022, updated 7 November 2024. The human-readable
[OCFL1.1 publication](https://ocfl.io/1.1/spec/) remains useful navigation, but the commit and byte hashes above
identify the actual reviewed source rather than assuming that mutable URL will remain unchanged. The schema is
explanatory; this reader implements structural and cross-record checks locally. No external schema or OCFL
implementation is a production dependency.

The retained test corpus comes from [zimeon/ocfl-py](https://github.com/zimeon/ocfl-py) at immutable revision
`a480226d54cf8d03d71ab8c56eb69ae8a78e231d`, version 2.1.0. Its unmodified producer wrote SHA-512 and SHA-256 objects
with three version states, edits, deletion, restoration, renames, aliases, empty and binary files. Its validator
accepted both objects; its extractor independently reproduced every authored version byte for byte. The fixture retains
full physical file bytes, hashes and extracted oracles. See
[fixture provenance](https://github.com/okikio/opfs/blob/7cbf96f/tests/fixtures/ocfl/README.md) for reproduction. These
fixtures prove interoperability with that producer profile, not deployed storage behavior or all OCFL validators.
