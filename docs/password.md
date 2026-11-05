# Preview a legacy password-protected ZIP member

```ts
import { createBlobSource } from "@okikio/opfs/source";
import { openZip } from "@okikio/opfs/archive/zip";

export async function preview(archiveBytes: ArrayBuffer, password: Uint8Array): Promise<Uint8Array | undefined> {
  const archive = await openZip(createBlobSource(new Blob([archiveBytes])));
  const entry = archive.entries.find((entry) => entry.kind === "file" && entry.encryption === "zipcrypto");
  if (!entry) return undefined;
  const result = await archive.read(entry.id, {
    password,
    maxPasswordBytes: 1024,
    offset: 0,
    length: Math.min(entry.size, 4096),
    verify: true,
    maxSourceBytes: 32 * 1024 * 1024,
    maxDecodedBytes: 64 * 1024 * 1024,
    maxOutputBytes: 4096,
    maxRequests: 1024,
  });
  console.log(result.integrity, result.encryption); // CRC evidence; authentication is always "none".
  return result.bytes;
}
```

This is read-only compatibility with traditional ZipCrypto, an obsolete cipher. It is not authenticated encryption and
is unsuitable for protecting newly created sensitive data. The API does not create encrypted archives. It supports
encrypted STORED and raw-DEFLATE members, while strong PKWARE encryption, central-directory encryption,
[WinZip AES](aes.md) uses a separate explicit native capability; other methods remain explicitly unsupported in this
legacy profile. Unencrypted reads retain their existing behavior.

Encryption is opt-in per read through explicit password bytes. `entry.encrypted` continues to describe directory
metadata; optional `entry.encryption` distinguishes `"zipcrypto"` from `"unsupported"`. Opening and planning require no
password and decrypt nothing. Reading encrypted content without a password refuses before opening member headers. The
library has no password cache, prompt, registry or callback that can assert authentication.

The caller chooses the password encoding. For a known UTF-8 producer, the caller can use
`new TextEncoder().encode(text)`; legacy archives can use other encodings, so the library does not guess. Password bytes
are bounded by `maxPasswordBytes` (default 1024), copied synchronously before the first source await, and used only for
that read's sequential state. The library does not mutate caller bytes. It clears its temporary password copy and
retires its cipher state when the read settles; this does not guarantee erasure of previous JavaScript engine copies or
garbage-collected memory.

## Prefixes, checksums and cost

The 12-byte encryption header contains only a weak password verifier. Passing it does not prove that the password is
correct: a wrong password can pass by chance. The verifier uses the central CRC high byte for ordinary members and the
DOS modification-time high byte for data-descriptor members. Local names, flags, method and encrypted timestamps must
agree with the indexed directory before payload decryption. AES extra fields cannot be reinterpreted as ZipCrypto.

Full decoded member CRC verification reports `checksum-verified`; it detects accidental corruption but does not
authenticate content, filenames, a sender or the archive. Wrong passwords or corruption can produce `checksum-mismatch`.
Prefix reads without full verification report `checksum-pending`, even after the header verifier passes. Their plaintext
can be wrong or later ciphertext can be corrupt. Password reads always include
`encryption: { kind: "zipcrypto", authentication: "none" }`. CRC success never changes that authentication value.

ZipCrypto is sequential. A STORED late-range read must decrypt and discard bytes from the start through the requested
interval. DEFLATE additionally decodes from the start. A small output limit therefore does not imply small source,
decrypt or decode work. `verify: true` consumes the entire selected member while retaining only the requested output.
Requesting the complete member also checks its CRC, even with `verify: false`, preserving normal ZIP read semantics. No
unrelated member is decrypted.

`plan(id, options)` remains a pure preflight. A password-enabled ZipCrypto member reports `access: "decode-from-start"`.
Its source allowance includes the 12-byte encryption header; local-header bytes remain an execution-time cost marked
`headerBytes: "unknown"`. STORED decoded work counts the decrypted prefix plus encryption header. DEFLATE decoded work
counts decrypted compressed bytes, encryption header and inflated bytes. Native decoder output chunk sizes can make
prefix work exceed the minimum requested decoded interval; the actual budget still refuses excess work. Full
verification plans the whole decoded member.

Both transform stages share aggregate admission so decryption and decompression cannot each reset a 64 MiB decoded
allowance. Per-read defaults remain 64 MiB source bytes, 4096 requests, 64 MiB decoded bytes and 16 MiB output bytes. An
optional shared archive ledger also bounds multiple reads. Source resources remain borrowed. Cancellation reaches source
reads and the owned decoder pipeline; the decoder is retired before the read settles. No background jobs, cryptographic
runtime dependencies or automatic extraction are installed.

## Independent evidence

`tests/fixtures/password/create.py` creates genuine 7-Zip ZipCrypto STORED/DEFLATE archives, then independently decrypts
and compares every payload using Python's standard `zipfile` reader. An InfoZIP stdin producer supplies an actual
data-descriptor member whose password verifier uses its timestamp. The script retains the 7-Zip stdin `E_NOTIMPL`
diagnostic instead of treating that unsupported producer path as evidence. Empty, odd-size, binary and 128 KiB payloads
have original full-byte oracles; malformed controls cover wrong passwords, later ciphertext corruption, local/central
disagreements, limits, caller mutation and cancellation. Native producers are test tools, not package runtime
dependencies.

The checked-in `provenance.json` pins the script, fixture JSON and each archive SHA-256. The producer used signed Debian
`7zip` package `22.01+really26.02+dfsg-0+deb12u1` and `zip` package `3.0-13+deb12u1` on arm64. The recorded local base
image is diagnostic provenance; installing those packages changes the filesystem, so it is not a publicly pullable
complete producer pin. Re-running the script creates randomized encryption headers and new archive hashes while the
original payload oracle stays fixed.

The implementation follows the traditional encryption section of the primary
[PKWARE ZIP format specification](https://pkware.cachefly.net/webdocs/casestudies/APPNOTE.TXT). It does not copy
third-party cipher source. [WinZip AES](aes.md) is a separate profile with whole-ciphertext authentication and explicit
native capability admission.
