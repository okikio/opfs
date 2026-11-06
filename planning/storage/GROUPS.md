# Expansion groups and remaining work

This index is for maintainers continuing the full expansion. Start with [current support](../../docs/expansion.md), then
use a row below to locate the next kind of work. The 895 historical catalog records are grouped by their proposed owner,
not by additive driver count. All original IDs and their constraints remain in [routing.json](research/routing.json). No
group is complete merely because it has one implemented member. References and tooling are inputs to verification, not
requests to turn an external program into a storage driver.

For each implementation, review the canonical skills/guides before design, again before editing and after the focused
tests. Record the actual contract review finding in the capability guide or commit when it affects use or maintenance.
Use native Web APIs, Deno standard library or explicitly approved dependencies. A missing approved dependency is a
reason to implement a bounded protocol/codec with independent fixtures, not to add a hidden runtime SDK.

The counts below come from the preserved routing inventory. The source files, public exports, tests and capability
guides establish present support; historical `current_opfs_status` fields describe their original checkpoint only.

| Proposed owner                                  | Records |
| ----------------------------------------------- | ------: |
| [existing-driver](#existing-driver)             |      16 |
| [object-native](#object-native)                 |      18 |
| [s3-profile](#s3-profile)                       |      91 |
| [object-profile](#object-profile)               |       1 |
| [service-object](#service-object)               |       1 |
| [http-access](#http-access)                     |       1 |
| [webdav](#webdav)                               |       2 |
| [runtime-binding](#runtime-binding)             |      21 |
| [record-store](#record-store)                   |      65 |
| [native-protocol](#native-protocol)             |       5 |
| [file-transfer](#file-transfer)                 |       3 |
| [cloud-drive](#cloud-drive)                     |      49 |
| [service-resource](#service-resource)           |      38 |
| [media-service](#media-service)                 |       1 |
| [content-repository](#content-repository)       |      16 |
| [content-view](#content-view)                   |       3 |
| [peer-records](#peer-records)                   |      15 |
| [decentralized-service](#decentralized-service) |      46 |
| [chain-publication](#chain-publication)         |      12 |
| [transfer](#transfer)                           |       7 |
| [archive-view](#archive-view)                   |       7 |
| [image-view](#image-view)                       |       8 |
| [backup-view](#backup-view)                     |       7 |
| [encrypted-view](#encrypted-view)               |       2 |
| [encryption](#encryption)                       |       4 |
| [repository-view](#repository-view)             |       1 |
| [dataset-view](#dataset-view)                   |      20 |
| [format-view](#format-view)                     |       2 |
| [preservation-view](#preservation-view)         |       4 |
| [mail-view](#mail-view)                         |       2 |
| [backup-service](#backup-service)               |       9 |
| [domain-connector](#domain-connector)           |      34 |
| [linked-resource](#linked-resource)             |       3 |
| [device-transfer](#device-transfer)             |       5 |
| [synchronization](#synchronization)             |       9 |
| [consistency-policy](#consistency-policy)       |      17 |
| [authorization](#authorization)                 |      15 |
| [behavior](#behavior)                           |      78 |
| [composition](#composition)                     |       6 |
| [host-profile](#host-profile)                   |      93 |
| [message-log](#message-log)                     |       1 |
| [retention](#retention)                         |       1 |
| [cache](#cache)                                 |       1 |
| [tooling](#tooling)                             |      66 |
| [reference](#reference)                         |      89 |

ZIP method 14 adds an unencrypted EOS-required raw-LZMA1 profile with bounded dictionary/CPU work and separate
full-member CRC. The generic read-only ZIP view exposes both BZip2 and LZMA kernel policies; selected views still
default to complete-member verification. Native libarchive refusals for empty LZMA members remain explicit diagnostics.

## Completion evidence for a record

A tested route names the exact public subpath, supported profile, independent fixture/provider, limits, cancellation,
recovery and package-consumer proof. A constraint names the missing transport/specification/permission or unsupported
semantics, the layer that owns it and the concrete change that would permit reconsideration. Neither an inherited family
label nor an unavailable live account is evidence of support. Do not mark a broad group complete while its remaining
records have neither outcome.

Native gzip/zlib/raw DEFLATE and optional Brotli/Zstandard streams compose with TAR. Availability is checked through the
host constructor, and Brotli/Zstandard EOF adds no independent checksum claim.

The focused archive/encryption inventory has 136 records with overlap into this catalog. Keep its crosswalk intact;
compression algorithms, archive containers, encryption envelopes, key derivation and backup layouts are different
capabilities. Partial preview may expose directory metadata, verify a covering encrypted segment or read a selected
member, but must state which surrounding bytes and metadata remain unverified.

LHA now indexes header levels 0–2 and previews ordinary stored members, with separate header and file CRC scopes. Native
JLHA/Lhasa/7-Zip/libarchive fixtures compare complete bytes. Compressed methods, extraction and non-ASCII encoding
inference remain unsupported; the observed JLHA level-0 header ceiling is a writer constraint, not a universal format
limit.

ARJ now indexes selected single-volume headers and previews STORED members. Native ARJ and 7-Zip compare every original
byte and the complete file set, including explicit directories and comments. Default prefix reads scan the whole member
for CRC32; unchecked partial reads retain pending integrity. Compressed decoding, encryption, multivolume archives and
nonzero extended headers remain unsupported. See [the ARJ guide](../../docs/arj.md).

The `db-memcached` record now has a [native classic ASCII client](../../docs/memcached.md), qualified against the
official server and independent native libmemcached full-byte/CAS operations. The earlier pymemcache captures remain
historical evidence, not the current executable oracle. A cache miss, eviction and unconditional deletion do not supply
filesystem semantics. The `format-mcap` record now has an [uncompressed recording view](../../docs/mcap.md): physical
enumeration, exact timestamps and separate summary/data/chunk/attachment CRC evidence. Compressed chunks, optional-index
semantics and application message decoders remain unsupported.

The `archive-binhex` profile preserves both forks through bounded replay and explicit CRC/terminal evidence; a data-only
preview does not verify the resource fork. The `format-shapefile` profile reads explicitly supplied 2D components and
preserves raw attributes at their physical row ordinals. These profiles do not infer host paths, encodings, CRS or
application decoders. The `queue-google-pubsub` route preserves native message IDs and delivery tokens rather than
creating a filesystem adapter. See the [BinHex](../../docs/binhex.md), [Shapefile](../../docs/shapefile.md) and
[Pub/Sub](../../docs/pubsub.md) guides for exact limits and current native evidence.

The `format-geotiff` catalog route now has a bounded classic uncompressed raster profile. The focused `image-qcow2`
record and catalog `format-qcow2` route share the standalone guest-byte reader. The `db-redis` and `db-valkey` routes
have separate native server evidence behind one RESP2 client; no generic record driver or filesystem adapter is
inferred. See [GeoTIFF](../../docs/geotiff.md), [QCOW2](../../docs/qcow2.md) and [Redis/Valkey](../../docs/redis.md) for
selected profiles, native evidence and remaining boundaries.

The focused `enc-jwe` record adds bounded compact direct-AES-GCM message previews. Whole-message authentication precedes
plaintext publication, so it does not offer streaming ciphertext decryption or cheap encrypted random access. The
`log-nats-jetstream` route preserves native message publication/sequence reads rather than filesystem operations. The
`format-parquet` route exposes selected flat physical numeric columns; logical conversions, nesting and arbitrary codecs
remain outside that profile. See [JWE](../../docs/jwe.md), [NATS](../../docs/nats.md) and
[Parquet](../../docs/parquet.md) for ownership, exact costs and verification limits.

The age v1 caller-file-key profile authenticates selected covering chunks and exposes a borrowed nested-preview source;
recipient unlocking and armored files remain separate. ORC adds flat uncompressed physical numeric columns with
DIRECT/RLEv1 stripe decoding and separate null masks; RLEv2 and generic codecs remain unsupported. AMQP 0-9-1 adds
mandatory confirmed publication and explicitly destructive auto-acknowledged queue reads over fresh injected channels.
See [age](../../docs/age.md), [ORC](../../docs/orc.md) and [AMQP](../../docs/amqp.md) for exact scope and evidence;
these profiles do not complete the encryption, dataset or record-store groups.

## Present scope by group

Each section distinguishes the implemented profile from the next boundary. Follow its capability guide for the public
contract and verification limits; a group name or catalog record is not a support claim.

### existing-driver

Existing file, record and object drivers; retain facade, runtime and artifact parity when extending them. The RxDB
driver currently borrows an RxCollection; it does not implement the separate direct RxStorage contract.

### object-native

GCS, B2, Swift, S3 and Azure have selected native clients. GCS retains exact provider-reported metageneration and CRC32C
metadata and constructs paired generation/metageneration conditions; neither a checksum field nor emulator reciprocity
proves byte validation or live Google guard enforcement. JSON support does not establish XML or gRPC support.

`amazon-glacier-vaults` now has an optional [native vault client](../../docs/glacier.md), covering bounded archive
uploads, explicit retrieval jobs, completed-output byte sources, native multipart operations and bounded part
reconciliation. Applications own cost approval, polling and durable receipts. SDK differential execution,
provider-native behavior and eligible-account proof remain separate qualifications; this profile supplies no OPFS
adapter, automatic transfer checkpoint, Select initiation or S3 Glacier storage-class support.

The per-record source audit still finds eleven native contracts without provider-specific implementations:
`akamai-netstorage`, `upyun`, `rados`, `ibm-classic-swift`, `memset-memstore`, `netlify-blobs`, `qingstor`,
`rackspace-cloud-files`, `vercel-blob`, `volcengine-tos` and `cdmi`. Each needs its own authentication, limits,
operation outcomes and independent fixture. Generic S3 or Swift support does not qualify a branded service; Glacier
vault jobs are distinct from S3 Glacier storage classes. Historical service names also need current availability
research before implementation. Across this group and existing-driver, 23 of 34 records have selected implemented
profiles; this count is not complete provider certification.

### s3-profile

Reuse the S3 client only after proving each provider's signing, listing, conditions, multipart and error dialect. lakeFS
has a distinct native REST staging/commit client; it does not establish S3 gateway parity. R2 bindings and Supabase
native files-bucket REST are separate APIs; the REST client preserves RLS omissions and distinct public/signed authority
without claiming S3 parity.

### object-profile

Decide the concrete provider profile from its catalog constraints; a compatible URL alone is insufficient.

### service-object

Firebase Storage has a native Rules-authenticated client with exact media extents, bounded delimiter pages and
multipart/resumable receipts. Official SDK/emulator flows include nonfinal chunk reconciliation and authenticated Rules;
no production IAM/App Check or canonical filesystem claim.

### http-access

Revision-bound HTTP resource reads exist; no directory or mutation semantics are inferred.

### webdav

Core file access and a distinct Nextcloud chunk-upload wire client exist; Infinite Scale has native read/ETag-guard
evidence but ignores create-only PUT, so atomic creation is unqualified; acknowledgments do not establish remote resume
state or multipart backend offload; SEARCH remains separate, and generic removal is refused because collection DELETE is
recursive.

### runtime-binding

Existing browser/host bindings cover selected APIs. Distinguish native ownership, permissions and transaction semantics
for remaining bindings.

### record-store

Existing SQL/record families, Workers KV and bounded D1 binding records cover selected stores.
[CouchDB](../../docs/couchdb.md) adds a native attachment client with whole-document revisions; it does not impose a
record layout or filesystem semantics. [etcd](../../docs/etcd.md) adds native byte keys, modification-revision
conditions, explicit lease policy and historical prefix cursors without a record layout. Remaining databases, queues,
logs and vector stores need different contracts. Redis/Valkey add independently qualified native RESP2 byte commands
with explicit expiry; record-driver revisions and filesystem semantics remain separate. JetStream adds bounded native
message publication and sequence reads, preserving retention and deduplication as stream policy.
[Memcached](../../docs/memcached.md), the `db-memcached` record, adds classic ASCII byte/CAS commands with explicit
expiry and flags; misses and eviction are not authoritative filesystem absence. [AMQP](../../docs/amqp.md) adds 0-9-1
confirmed queue publication and explicitly destructive auto-acknowledged reads over injected channels. This is a
selected queue profile for `log-rabbitmq`; RabbitMQ Streams, manual settlement and other queue policies remain separate.

### native-protocol

WebHDFS has an HTTP file client and conservative driver/adapter. Kernel clustered filesystems and procfs belong behind
explicit host capabilities, not an invented portable wire API.

### file-transfer

FTP/explicit FTPS have injected socket/TLS clients with genuine server proof. SFTP v3 adds a bounded packet client over
an explicitly authenticated SSH subsystem. SSH security and higher-level stream/checkpoint adapters remain separate.

### cloud-drive

Drive and OneDrive have ID-native stored-file/session clients without path projection; OneDrive sparse ranges remain
native evidence. Dropbox adds native revision reads, strict uploads and session offset evidence without a contiguous
destination claim. pCloud adds precision-preserving native uint64 IDs, explicit origin grants and bounded publication
receipts. Seafile adds native unencrypted library metadata, capability-isolated reads and collision-aware uploads,
independently exercised with the actual server/SDK. Remaining profiles need stable IDs, duplicate names, shared roots,
exports and session recovery. Yandex Disk adds native mutable paths, separately granted initial OAuth downloads and
pending operations; no immutable source or filesystem projection is inferred. The `cmis` record adds native Browser
Binding document operations with typed properties and change-token/version-series receipts; native SDK interoperability
does not qualify the archival server authentication boundary. Capability discovery, multi-filing and ACL behavior remain
repository-specific; this profile does not qualify other cloud-drive records.

### service-resource

Box provides native IDs, version-pinned reads and part/pending/final upload receipts. The separate `cmis` record is
tracked under [cloud-drive](#cloud-drive). Remaining service resources must preserve originals, renditions, access
controls and publication separately from generic file replacement. PocketBase adds native record-file fields, exact
media reads and explicit protected tokens, with independent server/SDK bytes and update/delete-rule distinctions; no
filesystem or resume claim.

### media-service

Preserve media processing/rendition state rather than treating an accepted upload as a ready downloadable file.

### content-repository

HTTP/IPFS and read-only OCI content profiles exist. OCI hashes complete bounded blobs into private sources; Git loose
objects verify complete SHA-1/SHA-256 bytes into private payload sources; packfiles, refs and other mutable repositories
need separate identity rules. Git LFS adds canonical pointers and native basic transfers, separate action grants and
bounded whole-object SHA-256 verification; no ref publication or transformed extension retrieval.

### content-view

CAR v1 indexes and verified block reads exist. UnixFS reconstructs selected file ranges and literal directories through
an injected verified block reader; complete-file traversal is explicit. Opt-in native Kubo fanout-256 HAMT adds
selected-route lookup and bounded complete directory-link listing, without reading descendant files. ArFS public 0.15
inspects supplied selected metadata revisions and explicit data bindings; private/historical profiles, discovery and
authentication remain separate. Full DAG completeness remains unclaimed.

### peer-records

Pending peer discovery, record authenticity, retention and transport profiles; they are not ordinary object PUTs.

### decentralized-service

Arweave has a selected RSA4096-PSS32 format-2 verifier, complete bounded payload-root snapshots and configured native
Fetch reads. Chain inclusion, proof-only ranges, publication/payment and other service contracts remain pending; content
addressing alone does not establish availability.

### chain-publication

Pending transaction submission, finality/reorganization and on-chain/off-chain data separation.

### transfer

GCS/tus and S3/Azure continuation cover selected profiles. [HTTP upload draft 15](../../docs/upload.md) adds interop10
descriptors, native offset reconciliation and explicit terminal receipts with fresh-client process-loss proof. Peer
exchange remains separate work; no generic transfer bridge or final-RFC claim is made.

### archive-view

ZIP/TAR cover documented reader/writer subsets; indexed GNU PAX sparse 1.0 reads reconstruct logical holes while
one-shot sparse readers still refuse; WinZip AES STORED/DEFLATE authenticates full bounded ciphertext before decryption;
DEFLATE decrypts all bounded compressed bytes before interval inflation, without authenticating metadata. CPIO newc/CRC
has indexed reads, hard-link data-owner resolution and a read-only view. CAB indexes bounded folder metadata and reads
NONE/MSZIP ranges with explicit history prerequisites, exact DEFLATE framing and finite CPU policy; 7z reads single
COPY/LZMA1/LZMA2 payloads and bounded encoded headers with distinct packed, metadata and decoded CRC scopes. Normal
GNU/BSD ar member sources support nested previews. Legacy ZipCrypto STORED/DEFLATE reads use explicit password bytes and
never assert authentication. Apple-profile XAR indexes bounded zlib/XML and reads stored/zlib members with separate
TOC/archived/extracted checks. RAR5 original-header indexing and STORED member CRC preview are supported;
compressed/encrypted RAR and solid/encrypted/multi-coder 7z remain pending. Pure bounded LZMA Alone/raw LZMA1/raw LZMA2
streams add explicit dictionary/reset/CPU policy and no checksum. XZ indexes single-stream LZMA2 with selected-block
CRC32/CRC64 checks; SHA-256, filter chains and concatenation remain unsupported. Unencrypted ZIP method 12 composes
BZip2 block verification with selected member reads and separate ZIP CRC. BZip2 adds a bounded non-randomized
single-stream codec, verified-block replay and separate whole-stream CRC; concatenation and legacy randomization remain
unsupported. The `format-wim` record adds ordinary stored/32 KiB XPRESS-Huffman/LZX resource and selected-image
previews, with separate resource/metadata SHA-1 scope, parent cancellation and finite chunk/table/CPU policy. Other WIM
codecs remain pending.

### image-view

ISO9660 primary and Joliet directory/member extents are indexed without mounts, with an explicit observable
parent-extent compatibility policy. Rock Ridge and additional image/container profiles remain separate. The `format-wim`
record is tracked under [archive-view](#archive-view). UDF1.02 adds one physical partition, ordinary short/long recorded
extents and exact member sources; descriptor CRC16 excludes payload integrity, while VAT/sparing/metadata partitions and
embedded/sparse allocations remain unsupported. Standalone QCOW2 v2/v3 adds selected uncompressed guest-byte mapping and
explicit zero regions; backing chains, compressed/encrypted layouts, snapshots and guest filesystems remain unsupported.

### backup-view

The `restic-repository` record still needs backup index, pack, snapshot, lock and key-policy interpretation with restore
verification. The distinct [Restic REST backend](#backup-service) stores opaque repository objects; its native object
API does not implement repository decryption or backup-file previews. Other backup indexes and chunk-reference layouts
remain format-specific.

### encrypted-view

[Cryptomator](../../docs/cryptomator.md) adds a selected format-8 SIV_GCM source with authenticated names and covering
chunks under caller-unlocked keys. Original EOF, freshness, name/content binding, directory traversal and unlocking
remain separate; WNFS still needs its own layout and key contract.

### encryption

The separate Tink payload profile does not implement these four systems; each requires its own format, KDF and threat
model.

### repository-view

Git loose-object inspection verifies explicit IDs and canonical raw tree entries. Packfiles, deltas, refs, DAG
completeness and worktree projection remain separate.

### dataset-view

FITS primary/IMAGE HDUs expose bounded typed element ranges and separate whole-HDU DATASUM/CHECKSUM verification. netCDF
classic adds CDF-1/CDF-2 raw/physical typed values and bounded interleaved record ranges, with explicit observed SciPy
compatibility. Zarr v2 adds uncompressed numeric chunk selection with explicit namespace stability and absent-chunk fill
masks. LAS 1.2 adds uncompressed point formats 0–3 with raw/scaled columns and opaque extensions. Classic HDF5 adds
bounded direct root links and allocated contiguous numeric views; chunked/filtered HDF5, netCDF-4 interpretation,
LAZ/COPC, TABLE/compressed FITS, compressed/v3 Zarr and remaining dataset/columnar profiles need individual decoders and
proof. Classic GeoTIFF adds selected uncompressed strip/tile windows and raw geospatial declarations; CRS
interpretation, compressed TIFF and COG qualification remain unsupported. Parquet adds flat physical numeric
PLAIN/uncompressed v1/v2 data pages with selected row ranges and separate validity bytes. Signed full-width integer
annotations that preserve the physical representation are accepted; other logical conversions, dictionaries, codecs and
nested records remain separate.

### format-view

Composition routes need an actual format decoder and byte-source contract before claiming a generic archive/reference
view.

### preservation-view

WARC indexes uncompressed stored blocks with optional whole-block digest checks. BagIt inspects explicit supplied
inventories and verifies selected file SHA256/SHA512 digests. OCFL1.1 resolves explicit version states and separately
verifies exact inventory/content bytes. ARC1.0 indexes uncompressed physical captures with explicit JWAT/IIPC descriptor
framing. WARC reconstruction remains pending; stored blocks are not HTTP entities.

### mail-view

MIME indexes strict CRLF physical parts and decodes bounded previews with explicit complete/prefix evidence. Explicit
LF-native mboxo/mboxrd framing now composes converted message sources with MIME. Other dialects and public streaming
parts remain pending.

### backup-service

The `restic-rest-backend` record has a [native REST client](../../docs/restic.md) for bounded opaque repository objects
and separate whole-object SHA-256 checks. It does not list files inside a backup or implement repository decryption and
restore; those belong to [backup-view](#backup-view). Other service retention, job state and restore APIs remain
pending; an initiated backup is not a file write receipt.

### domain-connector

Pending domain-specific resources; define their useful data model before deciding whether filesystem projection fits.

### linked-resource

Pending link resolution, authorization and identity rules; do not silently follow arbitrary origins.

### device-transfer

Pending caller-owned device capabilities, permission flow, disconnect and transfer-recovery behavior.

### synchronization

Pending conflict detection, reconciliation and deletion propagation policies; storage primitives alone are not a sync
engine.

### consistency-policy

Selected native conditions exist. Other policies must preserve ownership, stale reads, pinning and loss of authority
explicitly.

### authorization

Applications own credentials. Remaining schemes need explicit scope, expiry and per-target injection without ambient
discovery.

### behavior

Selected ranges, naming and composition behaviors exist. Assess each behavior against its controlling layer and
evidence.

### composition

Existing source/view/driver composition is explicit. Remaining layouts require bounds, visibility, cleanup and
invalidation contracts.

### host-profile

Use an explicit host filesystem driver where semantics fit; verify permissions, naming, links, durability and mounts on
the actual host.

### message-log

Google Cloud Pub/Sub has a bounded unary REST client for publication, pull and explicit settlement. Streaming pull,
ordering, retention and exactly-once processing remain separate; deliveries are not mutable byte-addressed files.

### retention

The catalog record is GCS Archive storage behavior: the native client can select Archive on upload and retain confirmed
class metadata. Archive is online, and its minimum billing duration does not prevent deletion. Class transitions, live
billing and retention enforcement remain separate owner policies.

### cache

The original `google-storage-rapid-cache` record describes an acceleration layer over GCS bucket data, not an
independent authoritative file store. No native Rapid Cache profile is implemented; configuration, cache state and
applicable deployment behavior need their own API contract and qualification. Memcached is the separate `db-memcached`
record under [record-store](#record-store).

### tooling

Retained comparison/testing inputs. Select immutable versions and approved test-only use; no runtime dependency is
implied.

### reference

Retained historical/specification inputs. Revalidate primary sources when implementing a current capability.
