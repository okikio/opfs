# Preview a selected Cryptomator file

This optional profile reads one encrypted file with keys the application has already unlocked. The application selects
the intended configuration, directory ID, encrypted name and content object. No password, key server, host filesystem or
vault directory is discovered automatically.

```ts
import { openCryptomator } from "@okikio/opfs/crypto/cryptomator";
import { createBlobSource } from "@okikio/opfs/source";
import { openZip } from "@okikio/opfs/archive/zip";

export async function preview(
  configuration: Uint8Array,
  masterKey: Uint8Array,
  encryptedName: string,
  parentDirectoryId: string,
  encryptedFile: Blob,
  subtle: SubtleCrypto,
) {
  const vault = await openCryptomator(configuration, masterKey, {
    subtle,
    maxSourceBytes: 8 * 1024 * 1024,
    maxDecodedBytes: 8 * 1024 * 1024,
    maxOutputBytes: 1024 * 1024,
    maxChunks: 256,
  });
  try {
    const named = await vault.decryptName(encryptedName, parentDirectoryId);
    const plaintext = await vault.open(createBlobSource(encryptedFile));
    try {
      const archive = await openZip(plaintext, {
        maxSourceBytes: 1024 * 1024,
        maxDecodedBytes: 1024 * 1024,
        maxOutputBytes: 65536,
      });
      const member = archive.entries.find((entry) => entry.name === "selected.txt");
      if (!member) throw new Error("The selected archive member is absent.");
      const result = await archive.read(member.id, { length: Math.min(1024, member.size), verify: false });
      return { name: named.name, bytes: result.bytes, archiveIntegrity: result.integrity };
    } finally {
      await plaintext[Symbol.asyncDispose]();
    }
  } finally {
    await vault[Symbol.asyncDispose]();
  }
}
```

The decrypted filename is associated with its parent directory ID. It is **not bound to the selected content object**.
Two names within one directory can be swapped without invalidating their authentication. The application owns that
mapping. The ZIP reader independently reports its member checksum scope; `verify:false` permits a selected preview with
a pending full-member checksum.

## What this profile verifies

Only Cryptomator format 8 with `SIV_GCM` is supported. A compact HS256 JWT is verified with the full raw 64-byte ENC32
|| MAC32 master key. Its format, cipher combination and shortening threshold are trusted only after verification. `kid`
is metadata and never causes I/O. JSON fields are primitive, unique and strictly framed; nested extensions, critical
headers and other algorithms are outside this selected profile. Selected format and shortening-threshold numbers require
canonical nonnegative integer JSON spelling; fractions and exponents are refused before numeric conversion.

Opening a file authenticates its 68-byte GCM header. The first 12 bytes are the nonce; the protected payload contains an
eight-byte reserved value and a 32-byte file key. This strict profile requires the documented FF reserved bytes. It
accepts header-only empty files; explicit empty trailing chunks are currently refused. These are profile choices, not
claims that every other representation is universally invalid.

`readVerified(offset, length)` authenticates every complete chunk covering the range before returning an owned byte
array. A full plaintext chunk is 32768 bytes; its ciphertext is 32796 bytes including nonce and tag. A one-byte preview
can therefore require one full chunk's physical read and native decryption. The chunk index and header nonce are
authenticated as associated data. Ordinary ByteSource `read` uses the same verification, enabling nested archive
readers.

Evidence says `covering-chunks-authenticated`. A zero-byte read performs no body I/O, but opening has already
authenticated the header. `verify` checks every present chunk without collecting the complete plaintext:

```ts
export async function verifyPresent(
  file: import("@okikio/opfs/crypto/cryptomator").CryptomatorSourceType,
) {
  return await file.verify({ maxCiphertextBytes: 8 * 1024 * 1024 });
}
```

`all-present-chunks-authenticated` does **not** establish the original file length. The original total length is not
authenticated in this format. Removing whole trailing chunks can produce a valid shorter object, even after full
verification. A trusted expected size/hash or application manifest is separate authority. Neither this API nor
cryptographic integrity proves freshness, complete directory membership, rollback resistance or publisher identity.

## Name authentication and native costs

Ordinary padded base64url `.c9r` names use AES-SIV. The parent ID is one associated data item, including the empty root
ID. Authenticated UTF-8 must be NFC; no silent normalization occurs. A literal U+FEFF is retained. Separators, NUL and
dot path components are refused. Names are returned as data, never extracted as host paths. Long-name `.c9s` lookup,
directory-ID hashing/traversal and symlinks are excluded.

WebCrypto has no AES-SIV or CMAC. The module authors the bounded RFC 5297 S2V / RFC 4493 CMAC framing around native
AES-CBC and AES-CTR. CBC's mandatory padding adds a block; the implementation selects the preceding CMAC block and
charges that native work. Secret-dependent carry reduction uses a mask where practical. No upstream implementation was
copied and no independent cryptographic audit or JavaScript constant-time guarantee is claimed.

At vault opening, native `generateKey` creates a separate nonextractable ephemeral HMAC-SHA256 key. After recomputing a
name's 16-byte SIV, native HMAC sign and verify compare it with the archived SIV. This internal equality witness adds
two native calls per name; it is not a vault wire field, a second master key or an application-supplied proof callback.
A malicious injected `SubtleCrypto` can break all guarantees: it is an explicit trusted capability. Native
OperationError failures are classified as authentication failures with their causes retained; other native/provider
failures retain their original identity.

## Limits, ownership and cancellation

Opening owns native key references and bounded raw copies. Dispose the vault and each plaintext source with
`await using` or explicit `Symbol.asyncDispose` in `finally`. Disposing a source releases its file-key slot; disposing
the vault prevents new work, joins admitted operations and retires remaining slots. Sources and signals passed by
callers remain borrowed. Raw key copies and private plaintext buffers are cleared where practical after native
settlement; JS engines and native crypto implementations do not provide an erasure guarantee.

The default aggregate ceilings are 64 MiB requested source, 4096 requests, 64 MiB decoded work and 16 MiB output.
Opening and subsequent operations share these lifetime allowances. Additional read/member ledgers narrow authority; the
same supplied ledger identity is charged once. Reservations are not refunded when a later reservation, provider or
authentication step fails. Source costs count complete covering ciphertext chunks; decoded costs count full covering
plaintext, configuration and name cryptographic work; output counts selected bytes and UTF-8 filename bytes. They are
not exact heap or CPU measurements.

Default profile caps are 16 KiB configuration (64 KiB hard ceiling), 4096 name bytes (16384 ceiling), 256 covering
chunks (4096 ceiling), 8192 lifetime native calls (1,000,000 ceiling), four concurrent operations (16 ceiling) and 64
live plaintext sources (1024 ceiling). Excess concurrency refuses without queueing. Native calls are pre-reserved per
operation: six for vault opening, two for file opening, nine for a name and one per covering content chunk. Each
dispatch consumes only its operation's credits. Unused credits after an error are not refunded, so this cap measures
admitted work rather than only completed calls. Per-call archive limits can be narrowed, not used to widen opening
authority. Whole-file `verify` also requires an explicit ciphertext allowance that includes the 68-byte header, even
when the header was authenticated during opening. All covering costs are reserved before selected output/chunk
allocation or physical reads.

Source descriptors, methods, limits and trusted crypto dispatch are captured before asynchronous work. Stable-source
evidence must be immutable, provider or caller; an identity alone is insufficient. `allowUnverifiedSource:true` is an
explicit caller assertion. Returned plaintext has no inherited identity because ciphertext identity alone does not
identify its key context.

Native crypto jobs cannot be interrupted. Abort stops admission and is checked after settlement before returning
plaintext. Opening signals remain effective in all later reads, including nested sources and zero ranges. Disposal joins
active work; foreign source callbacks must not await disposal of their own enclosing operation, which would form a
dependency cycle.

Password unlocking is excluded: the vault uses scrypt and AES-KW, and WebCrypto has no native scrypt. SIV_CTRMAC,
Hub/JWE unlocking, writes, whole-vault mounts, name/content mapping recovery and transparent storage lookup are separate
work.

Primary references are the pinned official
[Cryptomator vault format](https://github.com/cryptomator/docs/blob/e10cef2459fa320042ac426a9a1f4bf844648071/docs/security/vault.mdx),
[architecture](https://github.com/cryptomator/docs/blob/e10cef2459fa320042ac426a9a1f4bf844648071/docs/security/architecture.mdx),
[security target](https://github.com/cryptomator/docs/blob/e10cef2459fa320042ac426a9a1f4bf844648071/docs/security/security-target.mdx),
[RFC 5297](https://www.rfc-editor.org/rfc/rfc5297) and [RFC 4493](https://www.rfc-editor.org/rfc/rfc4493).

The [independent fixture recipe](../tests/fixtures/cryptomator/README.md) retains 19 released cryptolib 2.4.0 /
PyCryptodome reciprocal original-byte/name cases, exact artifact/package hashes and licensing. The native producer runs
offline and imports no candidate TypeScript code. Its proof is selected AES-256 interoperability; no direct published
AES-128 RFC known-answer run or independent security audit is claimed.

The same recipe now documents a separately qualified TypeScript producer. Its acquisition and offline production passed,
retaining all 19 native cryptolib reciprocal byte/name cases with OpenJDK 17.0.21 and Node 26.13.0. It uses Node's
AES-GCM primitives for content and labels its filename checks as authored RFC5297 framing over Node AES primitives. It
does not inherit the historical PyCryptodome attribution or claim an independent complete SIV implementation. The new
producer output remains separate from the frozen fixture; candidate-reader acceptance of that new output is a separate
check.

The focused benchmark separates a native preselected GCM chunk, warm selected/boundary/full reads, cold key opening,
authenticated names and a nested ZIP preview. Each lane checks the retained independent original before timing. A
37-byte full-chunk prefix still costs 32796 physical and 32768 decoded bytes; three bytes across a chunk boundary cost
65592 physical and 65536 decoded bytes. A native preselected-key lane omits metadata/key setup and admission. The
retained one-CPU, one-GiB sample does not establish a universal speed advantage.
