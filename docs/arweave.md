# Verify an Arweave transaction before previewing its data

Supply an expected transaction ID, a raw format 2 transaction JSON header, the payload source, and an explicit native
crypto capability. Verification returns a private owned snapshot only after the complete bounded payload matches the
signed data root. That snapshot can be passed to an archive reader or read by range.

```ts
import { verifyArweaveTransaction } from "@okikio/opfs/content/arweave";
import type { ByteSourceType } from "@okikio/opfs/source";

async function preview(
  id: string,
  header: Uint8Array,
  payload: ByteSourceType,
  subtle: Pick<SubtleCrypto, "digest" | "importKey" | "verify">,
): Promise<Uint8Array> {
  const transaction = await verifyArweaveTransaction(header, {
    expectedId: id,
    profile: "rsa4096-pss32-v2",
    subtle,
  });
  const verified = await transaction.verifyData(payload, {
    chunkProfile: "arweave-js-1.15.7",
    maxDataBytes: 8 * 1024 * 1024,
  });
  return verified.source.read(0, Math.min(4096, verified.source.size));
}
```

The caller retains ownership of the borrowed payload source. Its size and read method are captured before IO. Every
source extent must be exact; callbacks receive the composed abort signal. The verifier copies bytes into private storage
before awaiting hashes. Returned range buffers are fresh copies, so mutating either the original provider or a returned
range cannot change the verified snapshot. The snapshot's identity records the transaction ID, signed root, size, and
chunk profile. No source is closed and no URL is discovered or followed.

## What each check establishes

`verifyArweaveTransaction` checks that the expected ID equals the header ID and SHA-256 of the raw signature. It
computes the owner address as SHA-256 of the RSA modulus, reconstructs the SHA-384 deep-hash signing payload from exact
ordered binary tags and signed fields, and verifies RSA-PSS with SHA-256 and salt length 32. An optional `expectedOwner`
checks an address supplied by the application. This does not associate a person with that address.

The returned transaction says `integrity: "rsa-signature"`, `data: "not-checked"`, and `chain: "not-checked"`. The
embedded JSON `data` field does not participate directly in format 2's signing payload; the signed `data_root` and
`data_size` do. Changing embedded bytes can leave the header signature valid. The optional embedded `data` string is not
decoded as a payload. Only `verifyData` recomputes the root from complete supplied bytes and returns
`integrity: "rsa-signature-and-data-root"`. No unverified prefix is emitted.

This selected profile admits format 2, a 4096-bit odd RSA modulus with exponent 65537, absent/zero denomination, and
RSA-PSS with a 32-byte salt. Other valid protocol profiles, including format 1, different RSA salt lengths or keys,
nonzero denomination, ECDSA signatures, bundled data items, and ANS-104, are unsupported. Exact numeric JSON spellings
are checked before binary64 parsing; duplicate decoded keys, noncanonical base64url in IDs, signatures and signed
fields, unknown envelope fields, malformed Unicode and UTF-8, and BOMs are refused. Tags are retained as ordered encoded
binary pairs, without Unicode normalization.

Complete root verification uses the named ArweaveJS 1.15.7 partition: 256 KiB maximum chunks, rebalanced short final
nonempty tails below 32 KiB, and an empty terminal leaf at exact 256 KiB multiples. An empty transaction instead has an
empty root. Merkle leaf/branch offsets are 32-byte big-endian notes. Other valid partitions may produce different roots;
a mismatch in this writer profile is not a universal judgment of all Arweave proof grammars.

A valid signature and matching bytes do not prove publication, block inclusion, confirmations, finality, availability
elsewhere, or application trust. Native chunk proof paths, absolute storage offsets, trusted block anchors, range-only
proofs, uploads, wallets, funding, discovery and filesystem projection remain outside this slice.

## Read from a configured gateway

```ts
import { createArweaveClient } from "@okikio/opfs/arweave";

async function download(
  id: string,
  url: string,
  fetcher: typeof fetch,
  subtle: Pick<SubtleCrypto, "digest" | "importKey" | "verify">,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  const client = createArweaveClient({
    url,
    fetch: fetcher,
    subtle,
    profile: "rsa4096-pss32-v2",
    ...(signal ? { signal } : {}),
  });
  const remote = await client.open(id);
  const verified = await remote.read({ chunkProfile: "arweave-js-1.15.7" });
  return verified.source.read(0, verified.source.size);
}
```

The configured URL must be a bare HTTP(S) origin without credentials, path prefix, query, or fragment. The client
requests `GET /tx/{id}` for header JSON, then `GET /{id}` for decoded payload bytes. It does not use `/tx/{id}/data`,
which carries base64url text. Requests set `credentials: "omit"` and `redirect: "manual"`; only 200 responses with
absent/identity content encoding are admitted. The injected Fetch capability remains trusted to honor these options. No
ambient Fetch, crypto, cookies, secrets, retries, status checks, or alternate gateway fallback is acquired. HTTP
deployments provide no transport confidentiality.

A nonempty read uses one response body sequentially and checks exact signed length and EOF before accepting its root.
Content-Length, when supplied, must match. Short bodies, excess bytes, bad roots, source errors, and cancellation yield
no snapshot. Body readers are owned by the operation and are cancelled/released on failure, preserving primary and
cleanup failures. A signed empty payload needs no second request: its returned empty snapshot proves the signed empty
content, not the gateway's payload availability. Repeating `read` downloads/verifies again and consumes cumulative
budgets; there is no implicit cache or retry.

## Costs, budgets, and cancellation

This is a bounded materialized preview. Even a 1-byte range initially costs the complete payload read, full root
recomputation, and private snapshot storage. No constant-memory stream, cheap authenticated remote prefix, or native
streaming WebCrypto hash is claimed. Native Fetch and WebCrypto may allocate internal buffers outside these counters.

| Policy                                      | Default | Local hard ceiling |
| ------------------------------------------- | ------: | -----------------: |
| Raw JSON header                             |   1 MiB |              4 MiB |
| Tag pairs                                   |     256 |               2048 |
| Aggregate decoded binary tag bytes          |  64 KiB |            256 KiB |
| Quantity/reward decimal digits              |     128 |                512 |
| Complete payload / retained materialization |   8 MiB |             16 MiB |
| Cumulative hash input                       |  64 MiB |            256 MiB |
| Cumulative native digest calls              |    4096 |              16384 |

All caps are local implementation or caller policy, not claims of provider limits. Payload read extents are at most 256
KiB, with at most 128 partition records. Native body parsing permits at most 8192 reader results, including empty
chunks. Header collection with unknown Content-Length allocates at most the configured finite header ceiling.
Control-body source accounting reserves that entire ceiling before Fetch, including when the actual response is smaller.
Payload source accounting charges exact full requested bytes and logical 256 KiB source callbacks; those `requests` are
not a count of native HTTP requests. `decodedBytes` counts the admitted raw JSON; returned range copies charge
`outputBytes`. `hashBytes`, `digestCalls`, `keyImports`, `signatureVerifications`, `chunks` and `materializedBytes`
distinguish cryptographic work and retained data. These are work counters, not a heap estimate. Hash counters cover
explicit digest calls; native RSA verification may perform internal hashing and allocation outside those counts.

A supplied full SDK JSON object may contain base64url `data`, making its header larger than the default 1 MiB even for
an otherwise admitted payload. Prefer an actual header without optional embedded data, or explicitly set
`maxHeaderBytes: 4 * 1024 * 1024` within the hard ceiling. This does not authenticate the embedded body or raise the
separate full-payload ceiling.

The full payload source/request/materialization/hash plan is reserved before allocating the owned payload or invoking
the borrowed source. Failed work is not refunded. Constructor and opening limits remain authoritative for later reads.
Constructor crypto and materialization limits accumulate across all of a client's transactions. Opening and operation
limits may tighten them. An explicit archive `ledger` composes work across readers; supplying that same object at
several levels charges it once. Advanced `ledgers` composition captures a finite owner list and deduplicates by object
identity. The pure verifier admits at most 16 distinct explicit inherited owners; the client additionally caps all
inherited local and explicit owners at 16. Constructor, open and read each add a local owner, so fewer than 16 external
owners may fit. Avoid wrapping one shared ledger inside several distinct wrappers.

Abort signals from construction, opening and reads compose; a fresh child signal cannot override an aborted parent.
Checks occur before IO, around native crypto awaits, after root computation, and before returned range copies. Pending
WebCrypto cannot be interrupted; cancellation is observed after it settles. Borrowed callbacks and injected Fetch must
honor their own cancellation contracts. No network or observer event is authoritative evidence of verification.

## Compose with supplied public ArFS revisions

`verified.metadata()` decodes signed tags as strict UTF-8 and binds this verified ID, computed owner and owned source as
an `ArfsMetadataInputType`. Binary tags that are not valid UTF-8 refuse this conversion, while transaction verification
remains valid. Supply these values to `openArfs` and bind independently verified data snapshots to file reads by their
exact transaction IDs. The existing ArFS view still reports its supplied-inventory scope: this helper does not establish
the latest selected revision, directory completeness, chain state, or ownership by a human. Pin and metadata URLs remain
inert and are never fetched automatically.

The following complete composition keeps selected revision metadata and the file payload distinct. Its inputs are
supplied independently; nothing searches for newer revisions or resolves a URL.

```ts
import { verifyArweaveTransaction } from "@okikio/opfs/content/arweave";
import { openArfs } from "@okikio/opfs/content/arfs";
import type { ByteSourceType } from "@okikio/opfs/source";

interface SuppliedTransaction {
  readonly id: string;
  readonly header: Uint8Array;
  readonly payload: ByteSourceType;
}
async function previewArfs(
  drive: SuppliedTransaction,
  entities: readonly SuppliedTransaction[],
  fileId: string,
  payload: SuppliedTransaction,
  subtle: Pick<SubtleCrypto, "digest" | "importKey" | "verify">,
): Promise<Uint8Array> {
  const verify = async (input: SuppliedTransaction) => {
    const transaction = await verifyArweaveTransaction(input.header, {
      expectedId: input.id,
      profile: "rsa4096-pss32-v2",
      subtle,
    });
    return transaction.verifyData(input.payload, { chunkProfile: "arweave-js-1.15.7" });
  };
  const verifiedDrive = await verify(drive);
  const verifiedEntities = [];
  for (const entity of entities) verifiedEntities.push((await verify(entity)).metadata());
  const view = await openArfs({ drive: verifiedDrive.metadata(), entities: verifiedEntities });
  const verifiedData = await verify(payload);
  const file = view.file(fileId);
  const selected = await file.read({ transactionId: verifiedData.id, source: verifiedData.source }, {
    offset: 0,
    length: Math.min(file.size, 4096),
  });
  return selected.bytes;
}
```

## Evidence and reproducibility

The [fixture directory](../tests/fixtures/arweave/README.md) records pinned primary sources, independent ArweaveJS
1.15.7 native transactions, complete original-byte oracles, native chunk boundaries/proofs, signature payloads, and
signed ArFS composition records. The producer is test-only, runs offline with explicit resource limits, publishes
nothing and retains no private wallet. Protocol Fetch fixtures test client behavior; no deployed gateway or chain
verification is claimed.

The first genuine Node SDK producer used its default salt length and produced RSA-PSS signatures with a maximum-length
478-byte salt. Those retained vectors verify natively but are refused by this explicit PSS32 profile. The SDK's
WebCrypto driver's default is 32; its Node driver differs. A separate explicit `sign(..., { saltLength: 32 })` producer
and independent native RSA-PSS with a 32-byte salt check establish positive profile evidence. Native SDK verification
alone would not establish the selected salt profile. The initial profile mismatch and exact digest/signature diagnostic
remain in the fixture provenance instead of being relabelled as successful PSS32 interoperability.

The six workloads in `bench/arweave.bench.ts` compare complete original bytes before timing. On one Node 26.13.0
ARM64/macOS Apple M1 Pro run, median times were 2.13µs for a borrowed Blob 11-byte range, 0.293µs for a previously
verified owned 11-byte range, 47.1µs for a 1,048,577-byte owned copy, 1.42ms for a cold 1781-byte header, 2.32ms for a
fresh header plus complete 1,048,577-byte root/snapshot, and 2.39ms for that first verification plus the selected
11-byte preview. The root lane made 5 logical source callbacks and 36 digest calls over 1,049,985 hash-input bytes,
separately from header work. These are supplied-byte workloads without transport, SDK signing or chain checks. Blob and
owned-array copies use different mechanisms; their baseline does not establish universal codec, crypto or gateway speed.
Cold samples create fresh finite owners; warm copy sampling uses an explicit finite 64 GiB output allowance.
