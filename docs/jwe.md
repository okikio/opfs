# Authenticate a compact JWE before previewing it

The optional `@okikio/opfs/crypto/jwe` subpath opens a bounded encrypted message using a key supplied by the caller.
Opening authenticates the complete message before returning any plaintext. A later range read copies from that
authenticated snapshot; requesting a small preview still requires reading and decrypting the whole encrypted message.

```ts
import { openJwe } from "@okikio/opfs/crypto/jwe";
import { openZip } from "@okikio/opfs/archive/zip";
import type { ByteSourceType } from "@okikio/opfs/source";

export async function previewZip(
  encrypted: ByteSourceType,
  key: CryptoKey,
  subtle: SubtleCrypto,
): Promise<Uint8Array> {
  const message = await openJwe(encrypted, {
    profile: "jwe-compact-dir-a256gcm",
    key,
    subtle,
    maxEnvelopeBytes: 12 * 1024 * 1024,
    maxPlaintextBytes: 8 * 1024 * 1024,
  });
  try {
    const zip = await openZip(message.source);
    const entry = zip.entries.find((item) => item.name === "preview.txt");
    if (!entry) throw new Error("The archive has no preview.txt entry.");
    return (await zip.read(entry.id, { offset: 0, length: Math.min(entry.size, 4096) })).bytes;
  } finally {
    message.dispose();
  }
}
```

The caller obtains the encrypted source, trusted key and native cryptographic capability. This module does not read
credentials, discover globals, resolve key identifiers, connect to a service or close the borrowed source. The example
uses explicit disposal rather than runtime-specific resource-management syntax.

## The selected wire profiles

The caller must choose `jwe-compact-dir-a128gcm` or `jwe-compact-dir-a256gcm` independently of the untrusted header.
These profiles implement compact JWE from RFC 7516 with direct key use (`alg: "dir"`) and AES-GCM from RFC 7518. They
require a 16-byte or 32-byte high-entropy AES key, respectively, a 12-byte initialization vector and a 16-byte
authentication tag. The compact encrypted-key field must be empty. An empty plaintext is valid.

A raw `Uint8Array` key is read once and copied before any later option, source, ledger or cryptographic capability
getter can run. That private copy is imported as a nonextractable decrypt key and is cleared even if later capture
fails. Alternatively, supply a borrowed secret AES-GCM `CryptoKey` with the matching length and `decrypt` usage.
Password strings and other algorithms are refused. The injected native capability remains responsible for its own
correctness.

Input must contain exactly five unpadded base64url ASCII fields. Invalid alphabet, padding, nonzero unused pad bits,
extra fields and whitespace are refused. The original encoded protected-header bytes are authenticated as additional
data; the implementation never reconstructs them by serializing parsed JSON.

Protected headers use strict UTF-8 and bounded JSON parsing. Duplicate decoded member names, including escaped spellings
and duplicates in nested custom metadata, are refused before `JSON.parse` can discard evidence. A leading UTF-8 BOM and
unpaired Unicode surrogates are refused. The `alg` and `enc` declarations must match the pinned profile. `kid`, `typ`
and `cty` are authenticated inert strings, not instructions or trustworthy descriptions of the content.

Unknown noncritical metadata remains available through `header.raw`; only known fields appear in `header.protected`.
Unknown numeric metadata is not exposed as an authoritative numeric field. Critical parameters, compression, remote
keys, embedded public keys, certificates, agreement parameters and password parameters are outside this profile and are
refused. There is no JSON JWE serialization, multiple-recipient support, key wrapping, password derivation or encryption
API.

Authentication establishes possession of the supplied symmetric key and the integrity of this message's bytes. It does
not establish a sender, freshness, chain of trust, JWT claims, a filename or the safety of embedded HTML or archives. A
key shared between several parties does not identify which party wrote a message.

## Ownership, cancellation and disposal

`openJwe` captures the source's size, identity, stability and bound read method, declared options, ledger callbacks and
cryptographic methods before awaiting source I/O. Unrelated option getters are never enumerated. A source must assert
`immutable`, `provider` or `caller` stability. The explicit `allowUnverifiedSource` option waives that admission
requirement; it does not add stability or cryptographic authenticity to a changing provider.

Source callbacks are borrowed. Each exact interval is copied before another callback can reuse its scratch storage.
Callback allocations and native crypto allocations are opaque to the library; configured limits bound admitted work, not
every allocation inside a foreign implementation.

The injected cryptographic capability is trusted to authenticate correctly, but its returned buffer remains borrowed:
the library copies it into a private plaintext snapshot and does not erase the provider's backing storage. Later
provider mutation therefore cannot alter published plaintext. The returned object owns that private snapshot.
`read(offset, length)` returns a new caller-owned copy and its work counts. `source` exposes the same snapshot as a byte
source for another parser. That source is valid only while its owner is alive. It has no invented identity derived from
the ciphertext's caller-supplied identity. Dispose the owner after nested parsers have finished.

`dispose()` is idempotent, refuses future reads and clears the private snapshot on a best-effort basis. Copies already
returned to callers remain theirs and are not cleared. JavaScript, native cryptography, strings and the runtime may
retain other copies; disposal is not a physical-erasure guarantee.

Opening cancellation remains authoritative for every later range read, even when that read supplies a fresh signal. A
foreign admission callback may cancel or dispose reentrantly; the operation checks again before copying plaintext. A
completed read owns its copy and can finish before a subsequent disposal.

Native WebCrypto operations cannot be interrupted. If opening is canceled during one, its promise waits for the native
call to retire, clears any owned late plaintext scratch and then rejects without publishing the provider's result. If
key import or decryption also fails, an `AggregateError` preserves both the cancellation reason and the independent
provider failure. An authentication `OperationError` becomes a `JweError` with code `authentication` without its native
cause or speculative plaintext. Other provider failures remain visible.

## Limits and work accounting

These are implementation safety ceilings and caller policies, not limits imposed by the JWE standard. Every caller value
must be a nonnegative safe integer and must remain below its hard ceiling.

| Option              |             Default |         Hard ceiling |
| ------------------- | ------------------: | -------------------: |
| `maxEnvelopeBytes`  |              12 MiB |               48 MiB |
| `maxPlaintextBytes` |               8 MiB |               32 MiB |
| `maxHeaderBytes`    |               8 KiB |               64 KiB |
| `maxHeaderDepth`    |                   8 |                   16 |
| `maxHeaderNodes`    |                 256 |                 4096 |
| `maxStringBytes`    |    4096 UTF-8 bytes |    16384 UTF-8 bytes |
| `maxMemoryBytes`    | 96 MiB policy units | 384 MiB policy units |
| `maxReadBytes`      |               1 MiB |               32 MiB |

`maxMemoryBytes` uses a conservative materialization formula covering encoded input, strings, decoded ciphertext, the
combined cipher/tag buffer, borrowed native result and private retained plaintext copy. It is not a heap measurement or
a bound on native implementation scratch memory. The opening work report exposes that formula's admitted count.

Archive limits (`maxSourceBytes`, `maxRequests`, `maxDecodedBytes`, `maxOutputBytes`) and an optional external `ledger`
are retained across later reads. Read-local limits add constraints without replacing opening authority. The same
external ledger is charged once by identity. The combined owner list is limited to 16 distinct local and external
ledgers, so deeply nested operations can reach that limit before 16 external ledgers are present.

Before the first source callback, opening reserves the entire input's source bytes, requests and encoded-input decoding
work. It reads at most 64 KiB per callback. After compact framing reveals the plaintext length, it reserves header and
ciphertext materialization work and the complete retained plaintext as output before decoding or invoking cryptography.
Thus `maxDecodedBytes: 0` refuses before source I/O, whereas an output limit may require reading the framing first. A
later selected read charges its copied length to decoded and output bytes and performs no encrypted-source I/O. Returned
`work` values describe that operation; the opening report separately records authentication, retained plaintext and
native-call counts. Failed admissions can consume earlier quota reservations.

## Evidence and remaining verification

The retained RFC 7520 section 5.6 compact direct/A128GCM vector supplies an independent published wire example. Its
complete expected plaintext is checked by length and SHA-256 rather than reproduced in this repository. The fixture's
provenance records exact figure identities, primary document hashes and license. Authored tests construct RFC envelopes
using native WebCrypto without a candidate writer and compose authenticated plaintext with the existing ZIP reader.

All 35 focused cases pass on Deno 2.9.8, Node 26.13.0 and Bun 1.4.2 in an offline runner limited to 1 GiB, one CPU and
128 processes. The first run retained one lint finding in an intentional refusal catch; a comment-only repair passed the
complete focused matrix and formatting/lint checks.

Independent jose 6.2.15 producer/consumer evidence now retains eight complete original-byte cases: empty, binary,
decomposed Unicode and independent Python ZIP under both profiles. The first offline producer passed without importing
the candidate. Both SDK paths share the native AES provider, so this is independent JOSE wire evidence rather than an
independent cipher implementation. The focused matrix includes all eight native originals and both encrypted ZIP
previews. Strict type, installed-package and fresh-process import checks are separate integration gates; focused runtime
evidence does not replace them.

This is a deliberately narrow read-only profile, not a JOSE conformance suite, cryptographic audit or constant-time
implementation claim.

## Recorded small-message costs

`bench/jwe.bench.ts` asks how compact admission, complete authentication/private copying and later selected reads differ
in cost. Every native original and the selected ZIP bytes are checked before sampling. Fixture JSON/base64 decoding,
native baseline key import and warm-snapshot construction occur outside their respective timed bodies. Cold message
lanes include raw key import, complete source copying, header validation, authentication, private plaintext copying and
disposal. The warm lane retains a finite 64 GiB / 10,000,000-request allowance; ordinary per-read limits remain
unchanged.

One six-lane Node 26.13.0 / ARM64 Linux observation used an offline Docker runner limited to 1 GiB RAM with no swap, one
CPU and 128 processes. The table reports medians, in microseconds per operation; the retained report includes complete
distributions and percentiles.

| Workload                         | Bytes and work                                                              | Observed median |
| -------------------------------- | --------------------------------------------------------------------------- | --------------: |
| Raw memory copy lower bound      | 513-byte owned copy; no authentication                                      |        0.893 µs |
| Native GCM with known boundaries | 513-byte plaintext; key import, wire parsing and private copying excluded   |       41.542 µs |
| Cold direct A128GCM message      | 844-byte wire, 513-byte authenticated snapshot, one key import              |       88.125 µs |
| Cold direct A256GCM message      | 844-byte wire, 513-byte authenticated snapshot, one key import              |       92.125 µs |
| Warm authenticated range         | 128-byte copy at offset 211; no source I/O or crypto                        |        1.981 µs |
| Cold message and ZIP preview     | 391-byte wire, 182-byte authenticated ZIP, selected 19-byte member interval |      117.667 µs |

These workloads perform different work. They do not measure SDK speed, transport, rendering, large-message throughput or
a general relative cipher cost. No other owned test or benchmark ran during sampling, but an unrelated existing
container showed Docker CPU activity of 19.10% at the start and 15.88% at the end. It was left untouched. The system was
therefore not proven free of contention.

`tests/fixtures/jwe/benchmark.json` records the exact image, source/input hashes, resource state and qualifications. Its
15,574,005-byte raw report is retained losslessly as `benchmark.json.gz`; the gzip readback equals the original SHA-256.
Later prose/receipt formatting does not change the measured source or benchmark code.
