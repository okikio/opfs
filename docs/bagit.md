# Inspect a BagIt inventory and verify a selected file

BagIt stores preservation payloads under `data/` alongside manifests containing file checksums. It is a directory
convention, not a compressed archive. Supply the files and directories you already own; the library reads only their
explicit byte sources. It never walks a filesystem or retrieves a URL from `fetch.txt`.

```ts
import { createBlobSource } from "@okikio/opfs/source";
import { openBagit } from "@okikio/opfs/archive/bagit";

export async function inspectBag(
  files: readonly { path: string; blob: Blob }[],
  subtle: Pick<SubtleCrypto, "digest">,
) {
  const bag = await openBagit([
    { kind: "directory", path: "data" },
    ...files.map(({ path, blob }) => ({ kind: "file" as const, path, source: createBlobSource(blob) })),
  ]);
  const manifest = bag.manifests.find((entry) => entry.algorithm === "sha512" && entry.kind === "payload");
  const row = manifest?.rows[0];
  const selected = manifest && row
    ? await bag.verify(manifest.id, row.path, { subtle, maxVerifyBytes: 1024 * 1024 })
    : undefined;
  return { coverage: bag.coverage, info: bag.info, selected };
}
```

Pass bag-relative file names, including `bagit.txt` and each manifest. The explicit `data` directory record asserts that
this directory exists, including when its payload is empty. It is the caller's responsibility to obtain an exhaustive,
consistent inventory. Sources may have different snapshot identities; the library does not manufacture an atomic
revision across them. An empty `coverage.issues` array cannot prove that an omitted real file does not exist.

## Three separate questions

Opening parses a bounded BagIt 1.0 UTF8 metadata profile. Its result is not a declaration that the bag is complete or
valid under every RFC requirement. `coverage.scope` is always `supplied-inventory`; `dataDirectoryPresent` and the
issues compare declarations against exactly the supplied records. Missing referenced files remain inspectable.

Every payload manifest must list every supplied payload file exactly once. Coverage is checked for each manifest, not
the union of several manifests. Tag manifests must reference all payload manifests and cannot list payload files or
other tag manifests. Duplicate decoded paths in one manifest, directory references and ambiguous inventory names are
rejected. Missing tagmanifest-required manifest references appear in the coverage report. A tag manifest is not required
to list every optional tag file; the RFC recommends that wider coverage.

`verify(manifestId, path, {subtle})` reads one entire supplied file and checks one digest declaration. A successful
result has scope `selected-file` and integrity `manifest-digest`; it names the selected manifest, algorithm, checksum
and file provenance. It does not verify every row, establish metadata authenticity or change subsequent raw preview
results. A mismatch throws `checksum-mismatch`. A bag's sender can change both a file and its manifest; fixity is
corruption detection, not author authentication. Whole-bag validity requires additional work and is not exposed as a
boolean by this API.

`read(path, {offset, length})` returns exact raw bytes with integrity `none`. `source(path, limits)` returns a borrowed
range source suitable for `openZip`, `openMime` and other byte-source consumers. For example, an EML payload can be
opened with `openMime(bag.source("data/message.eml"))`. This composition does not implicitly hash the file first.

## Text, names and inert fetch declarations

The declaration must contain the two ordered fields `BagIt-Version: 1.0` and `Tag-File-Character-Encoding: UTF-8`;
labels and the UTF8 encoding label are accepted case-insensitively. UTF8 decoding is fatal and a BOM is rejected. LF, CR
and CRLF tag-file line endings are accepted, including a final unterminated line. Other BagIt versions and character
encodings are explicitly unsupported. Manifests use normalized lowercase alphanumeric algorithm names; SHA256/SHA512
checksum lengths are checked. Other hex checksum declarations remain inspectable, but verification refuses their
algorithms before reading the payload. MD5 and SHA1 verification are not implemented.

Manifest and fetch names decode only `%0A`, `%0D` and `%25`, case-insensitively, in one pass. `%250A` names literal
`%0A`; it does not become a newline. Other percent escapes and raw percent signs are rejected. Inventory names are
already decoded literal Unicode strings and are never URL-decoded. Spaces inside components and Unicode names retain
their exact spelling. No case folding, Unicode normalization or alias fallback changes identity. This conservative
profile rejects leading/trailing space or tab in a component, empty/dot/dotdot components, backslashes, NUL, unpaired
surrogates, absolute paths, drive prefixes and leading tilde forms. This is a narrower naming profile than all possible
host filesystems. Decoded CR/LF names remain inert map keys; never pass them directly to a host path operation.

`info` preserves bag-info field order and repetition. Continuations retain a line break normalized to LF and remove only
continuation indentation. `Payload-Oxum` must be a single decimal byte-count.file-count value; it is compared with
supplied file sizes, never accepted as a substitute for digest verification. Other metadata values are untrusted text.
Unknown tag file contents are not interpreted.

`fetch` retains absolute-URI declarations and an exact decimal length string or null for `-`. It does not fetch,
resolve, rewrite or allocate from those declarations. Coverage reports absent manifest membership and length mismatches
for supplied files. Remote holes remain missing-file issues until the caller explicitly supplies the files.

## Work limits and ownership

All sources are borrowed; no file, filesystem or network capability is acquired. Opening captures each source's size,
read method, identity and stability. Immutable/provider/caller evidence is required unless `allowUnverifiedSource` is
explicit. Source wrappers retain individual evidence; unverified inputs stay unverified. The caller must maintain the
cross-file snapshot and ensure no symlink or host alias was followed when creating the inventory.

Opening reads parsed metadata only: the declaration, root manifests, optional bag-info and fetch files. Payloads and
arbitrary tag content are read only on request. Tag files are bounded buffers, not streaming parsers. Selected SHA256
and SHA512 verification uses the injected native WebCrypto digest and buffers the whole selected file. The default
`maxVerifyBytes` is 1 MiB, with a hard implementation ceiling of 16 MiB. WebCrypto can allocate additional internal
copies; no streaming hash is claimed. Cancellation reaches source reads and is checked after digesting; already running
WebCrypto cannot be interrupted.

| Policy                                                | Default                       |
| ----------------------------------------------------- | ----------------------------- |
| Inventory records, including directories              | 10000                         |
| Payload and tag manifests combined                    | 64                            |
| Manifest/fetch/info rows and coverage issues combined | 100000                        |
| Parsed bytes in one tag file                          | 1 MiB                         |
| Parsed tag bytes combined                             | 8 MiB                         |
| UTF8 path bytes                                       | 8 KiB                         |
| UTF8 physical line bytes                              | 16 KiB                        |
| Accounted retained metadata                           | 16 MiB                        |
| Physical read chunk                                   | 4096 bytes; admitted 1..65536 |

Metadata accounting includes tag/path bytes and 128 bytes per record; it is not an exact JavaScript heap estimate.
Physical lines are admitted before an array of line strings is created. Each parsed tag also has at most
`max(2, maxRows)` physical lines. All limits are explicit implementation or caller policy; BagIt itself imposes no
payload-file size limit. Large raw files can still be previewed by ranges even if whole-file verification is refused.

The [archive work limits](archive.md) count source bytes, requests, decoded/verifier bytes and returned output
separately. Parsed tag buffers and verifier buffers count as decoded work; verification returns no payload output. An
optional ledger combines files and operations. Whole planned read extents and request counts are reserved before
allocating a buffer; failed or cancelled work can leave reservations consumed. `bag.work` records opening work.
`bag.source(path, limits)` keeps cumulative limits across all of that wrapper's range reads. Nested readers can count
the same logical bytes at multiple layers; these counts do not reveal hidden transport or SDK allocation.

A syntax/path failure throws `invalid-archive` or `unsupported-profile`; keep the original inventory and identify the
producer's actual format. Missing files and coverage gaps are metadata diagnostics. `budget-exceeded` means the selected
operation exceeded a configured limit; choose a smaller raw preview or raise the relevant finite policy when affordable.
Source, crypto and cancellation failures retain their own errors.

## Evidence and limits of the evidence

The retained fixture was generated and validated by an immutable Library of Congress bagit-python revision that emits
BagIt 1.0. It includes SHA256/SHA512 payload and tag manifests, empty/binary data and Unicode/space/newline names.
Independent Python validation rejects tampering, missing files and extra payload files. Every retained digest is also
checked against Python hashlib and this reader's explicit verifier. The
[fixture record](../tests/fixtures/bagit/README.md) records the commit, source SHA256, runtime, commands and known
producer limitation. Bagit-python 1.8 emits 0.97 and was not silently rewritten into 1.0 evidence.

The pinned producer does not escape literal percent signs in names. Its own validator rejects its generated
`literal%0A.txt` bag by confusing it with a newline filename. That failure is retained separately; the genuine validated
fixture excludes percent names, and authored spec-based tests cover `%25` and one-pass decoding. No upstream defect is
hidden by changing the reader's path rules. These cases prove the stated profile, not every existing BagIt tool or all
RFC conformance cases.

The governing format is [RFC 8493](https://www.rfc-editor.org/rfc/rfc8493.html). Its normative prose controls over its
illustrative ABNF, including Unicode and filename whitespace. Independent producer code is
[Library of Congress bagit-python](https://github.com/LibraryOfCongress/bagit-python/tree/4bd2713cedbe1f8e634567c20ef0dded9622011d).
