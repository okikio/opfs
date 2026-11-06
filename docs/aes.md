# Preview an authenticated WinZip AES ZIP member

A preview verifies all ciphertext belonging to the selected member first. STORED reads then decrypt covering blocks;
DEFLATE reads decrypt all bounded compressed bytes before inflating the requested interval. Supply the native WebCrypto
capability explicitly; importing the ZIP reader acquires no global cryptographic capability.

```ts
import { createBlobSource } from "@okikio/opfs/source";
import { openZip } from "@okikio/opfs/archive/zip";

export async function preview(
  archiveBytes: ArrayBuffer,
  password: Uint8Array,
  subtle: SubtleCrypto,
): Promise<Uint8Array | undefined> {
  const archive = await openZip(createBlobSource(new Blob([archiveBytes])));
  const entry = archive.entries.find((entry) => entry.kind === "file" && entry.encryption === "winzip-aes");
  if (!entry) return undefined;
  const options = {
    password,
    aes: { subtle, maxCiphertextBytes: 8 * 1024 * 1024, maxBlocks: 8192 },
    offset: 0,
    length: Math.min(entry.size, 4096),
    verify: false,
    maxSourceBytes: 9 * 1024 * 1024,
    maxDecodedBytes: 17 * 1024 * 1024,
    maxOutputBytes: 4096,
    maxRequests: 16,
  };
  const plan = archive.plan(entry.id, options);
  if (!plan.supported) throw new Error(`Preview exceeds policy: ${plan.reason}`);
  const result = await archive.read(entry.id, options);
  console.log(result.encryption, result.integrity, result.work);
  return result.bytes;
}
```

The application can pass `globalThis.crypto.subtle` at its capability boundary. The supplied `SubtleCrypto`
implementation is trusted to implement the native algorithms correctly. A caller that replaces cryptographic methods
with fabricated results removes that trust; the library cannot validate an injected cryptographic implementation.

## Supported profile and verification scope

This read-only profile accepts WinZip AE-1/AE-2 with 128-, 192- or 256-bit keys and STORED or raw-DEFLATE content. It
requires exact seven-byte AES extra fields in both local and central records, method 99, matching profile fields, and
consistent sizes. Ordinary version-needed minima remain 1.0 for STORED and 2.0 for DEFLATE; AES does not require a
blanket 5.1 value. Data-descriptor AES members, unknown vendor/version/extensions, other compression methods, strong
PKWARE encryption and encrypted central directories remain unsupported. Unencrypted and [legacy ZipCrypto](password.md)
reads retain their own behavior. The API does not write encrypted archives or silently fall back to another encryption
profile.

A successful AES read reports `encryption: { kind: "winzip-aes", authentication: "ciphertext-verified" }`. This verifies
the complete member ciphertext with its derived authentication key. It does not authenticate ZIP names, header metadata,
the entire archive, a publisher or a sender. Password-based verification also cannot rescue a weak password.
Applications must separately establish the trust and identity of an archive.

CRC and cryptographic authentication are separate results. AE-2 omits a plaintext CRC and reports
`integrity: "not-provided"`, including when `verify: true`. AE-1 reports `checksum-pending` for a partial preview, or
`checksum-verified` when `verify: true` or the requested interval covers the whole member. AE-1 full CRC checking
decrypts every block even when only a prefix is returned. Authentication always verifies the whole ciphertext, including
when `verify: false`. A weak two-byte password verifier is only an early rejection; no plaintext native call starts
until the complete ciphertext authentication succeeds.

For DEFLATE, a complete read or `verify: true` consumes decoder EOF and requires the exact declared plaintext size. AE-2
plans call this `full-member-decode`; the result still reports `not-provided` for CRC. AE-1 additionally checks its
plaintext CRC. A partial read with `verify: false` can stop after the requested interval. The native raw-DEFLATE codec
owns structural EOF validation; some runtimes accept truncated raw streams. Neither native EOF nor authenticated
ciphertext is reported as independently verified DEFLATE structure. Injected codec factories are trusted to implement
the requested codec correctly, just as the supplied cryptographic capability is trusted.

## What a small preview costs

Native WebCrypto has no incremental HMAC API. This implementation owns a complete ciphertext snapshot, bounded by
`aes.maxCiphertextBytes` (default and implementation ceiling 8 MiB). Native HMAC signing computes a full 20-byte tag;
the reader combines the archived ten-byte prefix with the computed suffix, then submits this complete candidate to
native HMAC verification. Native verification performs the comparison. This needs two whole-ciphertext HMAC passes and
native input copies. It is not streaming authentication, a constant-time JavaScript comparison, or an exact peak-heap
bound. No plaintext is released after a failed authentication operation.

WinZip's AES counter uses a different byte order from native multi-block AES-CTR. The reader serializes each
little-endian counter explicitly and submits at most sixteen bytes per native call. Calls are sequential, never a
fan-out of promises. `aes.maxBlocks` defaults to the implementation ceiling of 8192 calls per read (up to 128 KiB of
plaintext blocks). A late AE-2 STORED preview decrypts only its covering blocks after whole-ciphertext authentication;
an AE-1 full STORED CRC check may therefore refuse a large member that a small authenticated preview can read.

Every DEFLATE preview decrypts the complete compressed member, even for a one-byte output. Its compressed ciphertext
must therefore fit the 8192-call allowance, at most 128 KiB by default. After authentication, the reader reserves and
owns one extra compressed-plaintext buffer of that size. It awaits every native block call before constructing an
inflater, then submits copies of at most 1024 bytes to the codec. The inflated member can be larger, subject to the
separate decoded/output limits. No complete inflated member is retained for a short preview. This deliberate bounded
staging avoids native AES work racing with decoder cancellation or key/ciphertext retirement.

`plan()` performs no source or native cryptographic I/O. AES plans report `authentication: "full-member-hmac"` and
`cryptoBlocks`. STORED uses `access: "authenticated-range"`; DEFLATE uses `access: "decode-from-start"`. Planned source
bytes include salt, verifier, ciphertext and tag; local header bytes remain an additional execution-time cost.
`decodedBytes` charges both full ciphertext HMAC passes plus every decrypted covering-block byte for STORED. For DEFLATE
it charges both HMAC passes, all compressed plaintext once, and every actual inflated chunk. The planned inflated
minimum is the requested interval end, or the full declared size for complete verification; native chunk overshoot is
checked during execution and can refuse a preview. Passing compressed bytes into the codec does not charge them again.
`outputBytes` counts returned plaintext. The cipher and output limits are admitted before allocating their owned
buffers; the shared archive ledger also bounds repeated reads. Per-read source, request, decoded and output defaults
remain 64 MiB, 4096, 64 MiB and 16 MiB, respectively. There is no native elapsed-time guarantee.

Password bytes are copied before the first source await; `maxPasswordBytes` defaults to 1024. The caller chooses text
encoding. The source and cryptographic capability stay borrowed. Each read owns and retires its ciphertext buffer and
key references. Cancellation stops further admission, but a native cryptographic operation cannot be aborted: the read
awaits its settlement before checking cancellation and releasing its state. The reader also waits for the explicit codec
input pipeline and decoder reader to retire before clearing its compressed plaintext buffer. Temporary arrays are
cleared where possible, but JavaScript/native copies and garbage collection prevent any secure-erasure guarantee.

## Independent format evidence

The historical executed producer, retained as inert `tests/fixtures/aes/create.py.snapshot`, used genuine 7-Zip
AES-128/192/256 STORED output and compared all original payload bytes through independent libarchive `bsdtar` extraction
with the public fixture password. Its AE-1 controls explicitly change AE-2 version/CRC metadata over genuine producer
ciphertext; they are not claimed as direct AE-1 producer output. Libarchive must accept and compare those adapted
archives too. Genuine AES DEFLATE output and explicit AE-1/ordinary-version metadata adaptations are independently
accepted and compared through libarchive too; lowered STORED 1.0 and DEFLATE 2.0 headers retain genuine ciphertext.
Inputs cover empty, odd, binary and 8197-byte members, including a preview across the little-endian counter carry at
block 256.

The current [TypeScript producer](../tests/fixtures/aes/README.md) preserves the independent libarchive consumer and
metadata adaptations. It adds OpenSSL CLI primitive checks with authored WinZip envelope/counter glue; those checks are
distinct from independent native ZIP parsing. This port and its OpenSSL route have not yet run. Existing fixtures and
receipts retain their original executed-producer attribution.

The producer used 7-Zip 26.02 (signed Debian `7zip` package `22.01+really26.02+dfsg-0+deb12u1`) and libarchive 3.6.2
(`libarchive-tools` package `3.6.2-1+deb12u5`) on arm64. `provenance.json` pins script, fixture JSON and each archive
hash. The recorded local base image is not a publicly pullable complete-producer pin; installing signed packages changes
its filesystem. Fresh producer runs use randomized salts and produce different archive hashes while preserving the full
original payload oracles. These tools are test-only; the package adds no cryptography dependency.

Format choices follow the primary [WinZip AES specification](https://www.winzip.com/en/support/aes-encryption/). Native
operation/copy/counter semantics follow the
[Web Cryptography API Recommendation](https://www.w3.org/TR/2017/REC-WebCryptoAPI-20170126/). Algorithm compatibility is
not a security audit or a recommendation to create new encrypted ZIP archives.
