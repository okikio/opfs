# Read IPFS content with an explicit trust boundary

Use a content identifier (CID) when you need to name serialized content by its hash. A gateway can return a raw block, a
CAR archive of blocks, or a decoded file. These responses have different verification requirements. This implementation
verifies complete SHA2-256 blocks. It does not reconstruct UnixFS files or verify a file range against a DAG root.

This complete example verifies the raw `hello` block from the primary CID specification, then reads a range from the
owned verified snapshot. Replace the gateway with one that you operate or choose to contact.

```ts
import { openIpfsSource } from "@okikio/opfs/ipfs";

const source = await openIpfsSource(
  "f015512202cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
  {
    gateway: "https://ipfs.io/",
    mode: "verified-raw",
    maxResponseBytes: 1024,
  },
);
console.log(source.verification); // sha2-256
console.log(new TextDecoder().decode(await source.read(1, 3))); // ell
```

The initial GET downloads and hashes the complete block before returning a source. Later reads perform no network
requests. Their bytes are slices of that immutable snapshot. A partial response is never treated as a verified complete
block. Network errors, a different digest, unsupported hashes, oversized bodies, and cancellation reject the open
operation.

## Choose what you trust

`mode` is required. The result retains `verification` so a caller does not confuse an HTTP validator with CID integrity.

| Mode           | Returned bytes                                                      | Evidence and limits                                                                                                                                         |
| -------------- | ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `verified-raw` | Complete raw root block, then local ranges                          | Requests `application/vnd.ipld.raw`, checks full SHA2-256 against the requested raw CID.                                                                    |
| `verified-car` | Requested raw root block extracted from CAR v1, then local ranges   | Requests CAR v1 with `dag-scope=block`, indexes the bounded response and verifies the requested block. Unused blocks remain unchecked.                      |
| `trusted`      | Gateway's decoded file representation, optionally addressed by path | HEAD and conditional exact HTTP ranges bind a gateway representation. The gateway is trusted to resolve the CID and path. `verification` remains `gateway`. |

Verified byte sources currently require raw codec `0x55`, a full SHA2-256 multihash, and no path. Other codecs can be
parsed and their serialized blocks can be verified with the lower-level CAR reader. That does not decode DAG-PB,
DAG-CBOR or UnixFS, prove reachability, or establish graph completeness. CAR header roots are declarations from the
archive producer. A matching root declaration alone is not verification. `verified-car` locates the requested raw block
by its CID even when a producer supplies empty or different header roots.

For a gateway-resolved file, select trusted mode. This uses the same known raw block as the first example:

```ts
import { openIpfsSource } from "@okikio/opfs/ipfs";

const source = await openIpfsSource(
  "f015512202cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
  {
    gateway: "https://ipfs.io/",
    mode: "trusted",
  },
);
console.log(source.verification); // gateway
```

For a UnixFS directory root, an optional `path: ["reports", "report.txt"]` selects an existing file through the gateway.
The API encodes literal segments without allowing slash or dot traversal; only trusted mode supports these paths.
Trusted sources require a strong HTTP ETag by default. An explicit `assumeStable` assertion follows the
[HTTP source contract](http.md). No automatic replay identity is derived from the CID URL in trusted mode. Supply
`identity` only when the caller can bind the entire URL and authentication context to the same representation.

## Inspect a CAR without decoding the whole graph

A CAR (Content Addressable aRchive) stores length-prefixed blocks, each preceded by a CID. `openCar` borrows any
known-size [byte source](source.md), including an HTTP source or a local file source supplied by an application. The
index reads framing, CIDs and bounded lookahead, rather than every payload. Reading a block allocates its complete
payload and checks its digest before returning it.

```ts
import { createByteSource } from "@okikio/opfs/source";
import { openCar } from "@okikio/opfs/content/car";

async function inspectCar(bytes: Uint8Array): Promise<void> {
  const car = await openCar(createByteSource(bytes), { maxBlocks: 10_000 });
  console.log(car.roots); // producer declarations
  console.log(car.entries); // locations with integrity: "unchecked"
  for await (const block of car.blocks()) {
    console.log(block.cid, block.bytes.byteLength, block.integrity); // sha2-256
  }
}
```

`car.read(cid)` selects one indexed block and returns `{ cid, bytes, integrity: "sha2-256" }`. Index entries continue to
say `unchecked`; a previous successful read does not certify future bytes from a borrowed source. Each read verifies
again. `blocks()` is a single-pass pull iterator that verifies one complete block before yielding it. Breaking the loop
starts no more reads. The reader never closes the borrowed source. Pass an `AbortSignal` to the index operation or to
individual reads/iteration. An index signal controls index construction only.

The supported profile is CAR v1 with a canonical definite-length two-field DAG-CBOR header (`roots`, `version`),
CIDv0/v1 sections and full SHA2-256 block multihashes. Empty or missing declared roots do not imply corruption of
independent blocks. Duplicate block CIDs, padding/zero sections, extra header fields, noncanonical CBOR, CAR v2, other
block hashes and DAG traversal are unsupported and rejected. Supported CID text bases are CIDv0's implicit base58btc and
CIDv1 base32lower, base58btc and base16lower. Multibase base36 and other spellings are not supported. Codec/hash numbers
remain opaque structural fields; parsing does not prove registration or decoder availability.

## Allocation, physical work and ownership

The gateway's verified modes buffer a whole response: 8 MiB by default for raw, 32 MiB for CAR. `maxResponseBytes` can
change that policy up to the separate implementation ceiling of 256 MiB. `maxBlockBytes` defaults to 8 MiB and has the
same gateway ceiling. Verification uses native Web Crypto SHA-256, which needs a complete block and cannot be
interrupted in progress. Signals are checked before and after hashing. Copies and Fetch's own buffers mean peak memory
exceeds one block or response. No constant-memory streaming hash claim is made.

The independent CAR reader defaults to a 1 GiB source-size limit, a 64 KiB header, 8 MiB per block, 100,000 sections,
and 1,024 roots. Its shared physical-read ledger defaults to 64 MiB and 300,000 requests across indexing and later
reads. A large source can be indexed without fetching every payload, but repeated reads can exhaust that ledger. Pass a
`createSourceBudget` ledger to change or share that policy. Failed reads consume admitted budget too.

Every response acquired by this operation is consumed or its cancellation is awaited before failure returns. Fetch,
authentication callbacks, and injected sources stay caller-owned. Redirects are rejected and credentials are not
forwarded. No ambient credentials, pinning, uploads, IPNS, filesystem projection or automatic gateway failover exist in
this slice. A verified CID proves content integrity, not availability, retention, authorship or confidentiality.

## Evidence and format references

The tests use the primary CID spec's SHA2-256 `hello` vector and the unchanged official IPLD `carv1-basic` fixture with
[immutable provenance and copied-byte hashes](../tests/fixtures/car/README.md). They verify all eight producer blocks
and cover corrupt hashes, malformed/truncated framing, bounds, aborts and early iterator return. An actual loopback HTTP
server exercises raw, CAR and trusted conditional ranges. This is protocol-level HTTP evidence with independent producer
bytes; it is not live Kubo, public-gateway, UnixFS or full trustless-gateway conformance evidence.

Primary contracts: [CID](https://specs.ipfs.tech/cid/), [CAR v1](https://ipld.io/specs/transport/car/carv1/), and
[trustless gateway](https://specs.ipfs.tech/http-gateways/trustless-gateway/).
