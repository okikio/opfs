# Preview age payloads with an unlocked file key

An application that already owns an age identity service can inspect a ZIP inside an age file without collecting its
complete plaintext. Supply the unlocked 16-byte file key, an exact stable ciphertext source and explicit crypto
capabilities. This optional subpath reads the binary age v1 payload; recipient unlocking remains the application's
responsibility.

```ts
import { createDecipheriv } from "node:crypto";
import { openAge } from "@okikio/opfs/crypto/age";
import { createNodeAgeAead } from "@okikio/opfs/crypto/age-node";
import type { ByteSourceType } from "@okikio/opfs/source";
import { openZip } from "@okikio/opfs/archive/zip";

export async function preview(
  ciphertext: ByteSourceType,
  fileKey: Uint8Array,
  subtle: SubtleCrypto,
  memberName: string,
): Promise<Uint8Array> {
  const age = await openAge(ciphertext, {
    profile: "age-v1-file-key",
    fileKey,
    subtle,
    aead: createNodeAgeAead({ createDecipheriv }),
  });
  try {
    const zip = await openZip(age.source);
    const member = zip.entries.find((entry) => entry.name === memberName);
    if (member === undefined) throw new Error("Archive member does not exist");
    return (await zip.read(member.id)).bytes;
  } finally {
    await age.dispose();
  }
}
```

The source and crypto implementations are borrowed. The reader never closes those resources, discovers credentials or
imports Node crypto. The optional Node factory receives `createDecipheriv` explicitly. A browser or Worker can inject
`AgeAeadType` without importing that subpath. The provider must implement IETF ChaCha20-Poly1305 with an empty
associated-data string and must authenticate before resolving. A failed authentication barrier must reject with an
explicit, sanitized `AgeError("authentication", message)`. Other provider or capability faults retain their original
reasons, including `undefined`; the reader does not infer authentication from arbitrary error names or messages. The
Node adapter sanitizes only failure at its captured native `final()` barrier and preserves cipher construction and other
setup faults. An authentication sentinel means that the provider did not establish authenticated output, not that an
arbitrary injected implementation proved a particular bad tag. This is an explicit trust boundary: byte ownership checks
cannot prove that a provider performs crypto.

Native support depends on the supplied runtime, not the module name. In the retained Bun 1.4.2 run, `node:crypto`
refused this cipher with `ERR_CRYPTO_UNKNOWN_CIPHER`; the optional Node factory therefore cannot decrypt there. The
portable reader can still use an explicit provider. Its Bun tests inject a bounded test-only Deno cipher oracle because
the CI job already declares Deno. That helper is neither exported nor a production fallback. Native factory availability
is checked separately from portable reader fixture coverage.

## What is authenticated

Opening authenticates the original header bytes and the final payload chunk. It then exposes the plaintext length and a
logical byte source. This proves neither the integrity of skipped intermediate chunks nor sender identity. An unknown,
syntactically valid recipient stanza remains authenticated opaque metadata; its presence does not mean that its
recipient algorithm is supported.

`read(offset, length)` authenticates every 64 KiB chunk covering the selected interval before releasing the operation's
result. Its integrity label is `selected-chunks-authenticated`, including an empty read, which authenticates no
additional chunks. `verify()` separately reads and authenticates every payload chunk and reports
`all-chunks-authenticated`. Corruption in an unselected middle chunk can remain undetected until that chunk is selected
or the whole payload is verified. Each operation returns owned bytes; mutating them cannot change later reads.

There is no unauthenticated plaintext stream. A selected read buffers its complete returned interval and one
authenticated covering chunk at a time. The Node adapter withholds native `update()` output until `final()` succeeds.
Neither the reader nor the adapter makes a constant-time or side-channel audit claim. They do not hide ciphertext size,
access patterns or selected offsets.

## Costs and bounds

`plan(offset, length)` performs no I/O or quota reservations. It reports exact ciphertext requests, returned bytes and
covering plaintext bytes for a selected read. Each covering chunk requires one source request and includes a 16-byte
tag. A short interval near a chunk boundary can require two complete chunks. The opening header scanner uses bounded 4
KiB lookahead: it can fetch payload bytes while locating the header terminator. Those bytes count toward opening work.
Opening separately fetches the 16-byte payload nonce and the final chunk.

The default header ceiling is 64 KiB, with an implementation ceiling of 2 MiB. There are at most 256 recipient stanzas
by default and 1024 with an explicit policy. The returned-interval default is 1 MiB and the ceiling is 32 MiB. Selected
reads admit at most 1024 covering chunks by default; whole verification admits 16384 chunks by default. Larger explicit
policies remain bounded by the implementation ceilings documented on `AgeOpenOptionsType`. The logical plaintext ceiling
is 1 TiB. This first slice does not accept unknown-size sources.

`maxSourceBytes`, `maxRequests`, `maxDecodedBytes` and `maxOutputBytes` are cumulative opening-owner budgets. A read can
add tighter operation budgets and an external `ledger`. Opening and operation owners both remain authoritative; passing
the same external ledger does not charge it twice. The total inherited owner ceiling is 16, including generated local
budget owners, rather than a promise that 16 external owners can always be added.

Selected reads reserve source, request, decoded and returned-output costs before allocating their result or fetching
payload bytes. Decoded work includes both the admitted provider plaintext and its private copy. Materialization counters
are conservative reader-owned allocation units, not measured heap usage or a whole-provider heap bound.
`plan().materializedBytes` and `plan().peakMaterializedBytes` exclude injected provider scratch. Source callback and
native crypto allocations remain opaque to this library.

The optional Node factory adds bounded private key, nonce, sealed-input, tentative-plaintext and returned-output copies.
Its conservative simultaneous allocation units are at most `sealed.length + 2 * plaintext.length + 44` bytes per call,
in addition to the reader's own work. The native cipher and its returned temporary buffers can allocate further storage;
neither this count nor the reader's `maxMemoryBytes` claims to cap that native heap.

## Lifetime and extension boundaries

The reader copies the file key before reading later option or capability getters. It captures source descriptors and
borrowed methods once before I/O. A source must explicitly declare immutable, provider-backed or caller-asserted
stability. An identity string alone cannot establish that evidence. The source must keep its ciphertext revision
unchanged throughout opening and later reads.

Only one read or verification operation can run at a time. Overlapping calls reject with `busy`; there is no hidden
queue. Opening cancellation remains authoritative even when a later operation supplies a fresh signal. `cancel()` stops
new work promptly. `closed` joins an outstanding borrowed callback and retains a late callback failure. A callback must
not await `closed` while it owns the callback being joined, because that creates a join cycle. `dispose()` combines
cancellation and this join. The derived source cannot outlive its owner.

Private keys and scratch are cleared best-effort on retirement. JavaScript cannot guarantee erasure of native, JIT or
garbage collector copies. Borrowed provider storage is not erased. The reader takes a private authenticated plaintext
copy so a provider retaining its result cannot mutate a published snapshot. The caller retains ownership of the input
file key and returned plaintext. Disposing the reader does not erase either; the application owns their retention and
best-effort erasure.

A third-party identity implementation can supply an unlocked file key without being trusted to authenticate the header:
this reader verifies the header MAC itself. Recipient selection, X25519, scrypt, SSH, plugins, passwords and identity
storage remain separate capabilities. ASCII armor, encryption, resumable writes and automatic network fetches are
outside this profile.

## Evidence and compatibility

The grammar target is the
[immutable C2SP age specification](https://github.com/C2SP/C2SP/blob/037e546d164a89fd7577df2c18df80bb54bd246e/age.md)
and its STREAM chunk construction, not an invented encryption envelope. Authored tests build primary grammar envelopes
with independent native encryption. Separately retained native Go age v1.3.2 fixtures contain eight complete originals
and eight successful CCTV vectors, produced and fully checked without the candidate library. All 50 selected CCTV
vectors retain their original expectations; the 42 negative cases cover header, HMAC and payload refusal without
claiming native negative conformance or upstream streaming-prefix parity. See the fixture provenance for immutable
source identities, exact full-byte receipts and license scope. Strict type, installed-package and fresh-process import
checks are separate integration gates; focused runtime evidence does not replace them.
