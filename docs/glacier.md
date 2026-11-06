# Glacier vault archives and retrieval jobs

Use this native client for the original Glacier vault API (`2012-06-01`). Existing Glacier customers can publish
archives and explicitly retrieve completed job output. S3 Glacier storage classes use the S3 API instead. This module
does not create a filesystem, translate archive descriptions into paths, or start retrieval as a side effect of reading.

```ts
import { createGlacierClient } from "@okikio/opfs/glacier";
import type { GlacierOptionsType } from "@okikio/opfs/glacier";

export async function previewCompletedJob(
  capabilities: GlacierOptionsType,
  completedJobId: string,
) {
  const client = createGlacierClient(capabilities);
  const source = await client.openOutput(completedJobId);
  const preview = await source.read(0, Math.min(4096, source.size));
  return { preview, originalArchiveOffset: source.archiveOffset };
}
```

The application supplies endpoint, account, vault, region, Fetch, SubtleCrypto, clock, and credentials. Account can be
the explicit 12-digit account ID or `"-"` for the credential account. Pass `crypto.subtle` from the application's chosen
runtime; the client performs no ambient crypto or credential discovery. Static credentials and request-policy values are
snapshotted at construction; a refreshable credential supplier runs on each admitted attempt. Operation signals and
checksum settings are captured before awaiting. Replacing an options property cannot change an active operation, while
aborting its captured signal remains live cancellation authority. Fetch, crypto, and the client are borrowed resources;
the client has no worker, timer, background polling, or connection to dispose.

## Request retrieval explicitly

```ts
import type { GlacierClient } from "@okikio/opfs/glacier";

export async function requestPreview(client: GlacierClient, archiveId: string) {
  // Persist this receipt using the application's own durable storage.
  return await client.startArchiveJob(archiveId, { tier: "Bulk" });
}

export async function inspectPreview(client: GlacierClient, jobId: string) {
  const job = await client.describeJob(jobId);
  if (job.StatusCode === "Failed") throw new Error(job.StatusMessage ?? "Retrieval failed.");
  if (!job.Completed || job.StatusCode !== "Succeeded") return { state: "pending" as const };
  return { state: "ready" as const, source: await client.openOutput(jobId) };
}
```

Retrieval may incur charges and take substantial time. The caller chooses tier, authorizes cost, persists the job ID,
and schedules later inspection. A started job cannot be cancelled. Aborting Fetch stops local work and does not cancel
the remote job or its cost. Completed output remains available for at least 24 hours after completion; it is not
permanent storage. `openOutput()` refuses pending or failed jobs and does not wait for them.

Ranged initiation uses `{ start, end, archiveSize }`, with inclusive archive offsets. Start must be MiB aligned. End
must be the byte before a MiB boundary or the actual final archive byte. The declared size is a caller assertion used
for local admission, not a remote metadata lookup. `readOutput(job, offset, length)` subsequently uses offsets relative
to the job's selected output. The source exposes `archiveOffset` separately so a preview does not confuse output offset
zero with original archive offset zero.

`listJobsPage()` returns one page, with a 1–50 limit and nullable terminal marker. Inventory retrieval is an explicit
historical snapshot job, not a current directory. `startInventoryJob()` accepts JSON/CSV, marker, and limit; continuing
inventory pagination starts another job. Native job metadata retains action-dependent null fields. Select metadata can
be inspected, but Select initiation/output is outside this profile.

## Upload and retain receipts

```ts
import type { GlacierClient } from "@okikio/opfs/glacier";

export async function saveArchive(client: GlacierClient, bytes: Uint8Array) {
  return await client.uploadArchive(bytes, { description: "application backup" });
}
```

Single uploads copy the input before asynchronous hashing and dispatch. Callers must synchronize any concurrently
written shared memory while supplying the snapshot; copying does not create atomicity. The default materialization
ceiling is 16 MiB; `maxBodyBytes` changes that explicit memory policy. This is an implementation allocation limit,
separate from provider archive limits. The client sends independent linear SHA-256 and Glacier tree hashes. Descriptions
allow at most 1024 printable ASCII characters and are neither unique names nor a recovery API. Persist the returned
archive ID and location. The client validates reported upload checksum headers; this is a provider acknowledgement, not
an independent download test.

Job initiation, archive publication, multipart initiation, and completion are sent once even when their byte bodies are
repeatable. `GlacierPublicationError.outcome === "unknown"` means dispatch happened but no usable receipt was retained.
The remote mutation may have succeeded. A valid receipt survives later validation or cleanup failure in `error.receipt`,
with outcome `"confirmed"` referring to that publication identity; callers must still inspect the error cause. Retrying
an unknown single upload or job initiation can allocate another resource. Matching descriptions cannot resolve a lost
archive ID.

`deleteArchive(id)` explicitly deletes an archive and is idempotent. It can affect pending retrievals. It is never
performed by output-source or preview cleanup. A provider refusal is a `GlacierError`, retaining status and request ID.
Cleanup failures can be aggregated with the operation failure rather than replacing it.

## Multipart archives

```ts
import type { GlacierClient } from "@okikio/opfs/glacier";

export async function saveParts(client: GlacierClient, chunks: AsyncIterable<Uint8Array>) {
  const upload = await client.createUpload(4 * 1024 * 1024);
  // Persist upload.id, upload.partSize, endpoint/account/vault/region, and source identity.
  const parts = [];
  let start = 0;
  for await (const chunk of chunks) {
    parts.push(await client.uploadPart(upload, start, chunk));
    start += chunk.byteLength;
    // Persist each acknowledged extent and raw tree hash before advancing durable progress.
  }
  return await client.completeUpload(upload, parts, start);
}
```

The example requires 4 MiB nonfinal chunks and a nonempty final chunk of at most 4 MiB. Caller storage owns durable
receipts and source replay identity. If an operation fails, retain the upload instead of silently deleting possible
work; reconcile or explicitly abort it according to application policy.

Provider parts are fixed power-of-two MiB sizes from 1 MiB through 4 GiB, with at most 10,000 parts. The client's
materialization ceiling still applies to each part. One immutable part is hashed and sent at a time; no whole-archive
buffer or custom incremental SHA implementation is required. A logarithmic digest spine computes tree roots. Completion
reduces ordered part tree roots, checks exact coverage, and rejects gaps, overlaps, out-of-order input, undersized
nonfinal parts, or a mismatched total size before dispatch.

`uploadPart()` can replace the same aligned extent and can retry its copied bytes. A failed part request does not prove
the part is absent; reconcile using native listings. `listPartsPage()` and `listUploadsPage()` return at most 1,000
entries and nullable markers. `listParts(upload, { maxPages })` reads all bounded pages, detects marker cycles/duplicate
extents, and sorts parts by offset. Listed sparse parts are not a contiguous acknowledged transfer offset. The client
does not compare listed hashes to an original source identity for you; applications must do that before trusting resumed
work.

AWS documents a short, unspecified period when repeating the identical completion returns the same archive ID.
Completion is not automatically retried here; the caller can promptly repeat the same upload ID, total size, and part
receipts. No durable retry deadline is promised. Completed IDs disappear from multipart listings even during that retry
window, so disappearance cannot prove publication. An unknown completion without a recovered archive receipt remains
unknown. `abortUpload()` discards unfinished state explicitly; settle concurrent part requests first. This module
supplies native multipart mechanics, not a generic checkpoint destination or durable orchestrator.

## Exact bytes and archive preview

`readOutput()` returns `{ bytes, checksum }`. It validates exact status, finite job-relative Content-Range, declared
length when present, actual body length, and identity encoding. Output is fully admitted within the materialization
ceiling before publication. Cancellation retires the acquired reader and awaits cleanup. A zero-length source read is
local and does not prove remote existence or availability.

Internal reads use the existing `openBytes()` capability so exact first-party source rejection delivery remains visible
to its retirement owner. A delivered read rejection is not cancelled again merely to reproduce a native stored error.
Any cancellation already started by abort and any release failure are still awaited and retained. A custom borrowed
reader's rejection cannot prove its producer physically closed; the operation refuses success and releases the acquired
reader without claiming stronger termination evidence or taking another consumer's lock.

`checksum` distinguishes no applicable checksum, a matched service checksum, and a matched caller-supplied
`expectedTreeHash`. `requireChecksum` without a caller hash rejects inventory and ineligible archive extents before
crypto, credentials, or transport. A service-supplied hash is not an independently trusted expected plaintext hash. The
caller must bind its expected digest to the exact selected extent. Arbitrary byte ranges may lack a service tree hash:
MiB alignment alone does not imply tree-node alignment. Both the original retrieval and the selected output, translated
back to original archive coordinates, must be nodes of the archive tree, including promoted odd tail nodes. An
unexpected checksum header for an ineligible extent is refused rather than counted as evidence. Empty local reads cannot
satisfy checksum-required policy.

A completed output source implements `ByteSourceType`; existing ZIP and other archive readers can borrow it to select
members. To inspect an archive directory without downloading all members, the retrieval must include the index bytes
that format needs. A subset job may omit them. Request an additional job explicitly rather than treating unavailable
extents as zero bytes or automatically triggering paid retrieval. Glacier encryption at rest does not provide client
archive decryption keys. Encrypted archive readers retain their own key, authentication, and range requirements.

## Evidence and exclusions

The authored test suite covers malformed ranges, publication outcomes, multipart coverage, page cycles, mutable inputs,
cancellation, and exact output. The
[independent fixtures](https://github.com/okikio/opfs/blob/codex/release-2026-10-06/tests/fixtures/glacier/README.md)
retain a separate offline run of the unchanged official botocore tree functions and the public Smithy signer. Thirteen
complete originals, their leaves, and fifteen multipart extents have frozen checksum expectations. Eleven complete
signing preimages are retained; six map to public operations and five are explicitly limited synthetic controls.
Candidate tests compare the full submitted bytes and exact applicable headers against those frozen results.

The independent run completed with exit zero and no OOM in three serial, offline 512 MiB containers. This establishes
deterministic oracle outputs; candidate runtime, package, benchmark, CI, and live-service checks remain distinct
evidence. It does not establish AWS authentication acceptance, archive publication, retrieval completion, billing, or
availability.

The retained Moto source used for research has a linear hash in place of the tree checksum, ignores output ranges, uses
placeholder job metadata, and lacks multipart. It cannot prove this client's tree/range/multipart contract. Production
contains no AWS SDK dependency. A custom Fetch fixture is not a provider oracle; the independent algorithm/signing
fixtures do not substitute for live service behavior.

Glacier signing uses general AWS path canonicalization, which normalizes path segments and escapes already escaped
percent bytes again for the signature. The actual wire path remains unchanged. This differs from S3's literal-path
signing policy; S3 addressing is not reused. The reviewed installed `@smithy/signature-v4` 5.7.2 source supplies
independent path-policy evidence. The retained Smithy execution verifies its complete signing preimages; five synthetic
controls remain separate from public operation compatibility. Receipt locations must retain the exact configured
endpoint prefix, vault, resource, and identity, without userinfo or cross-origin redirection. The credential-account
`"-"` may resolve to a native 12-digit account in the receipt.

Vault provisioning, Vault Lock, policies, notifications, provisioned capacity, Select initiation, S3 Glacier classes,
OPFS adapters, a bridge, and automatic transfer checkpoints are excluded. Real AWS proof additionally needs an eligible
existing account, explicit vault/region/archive scope, caller-owned authentication, disposable mutation scope, and
approved retrieval cost.

Protocol sources: [checksums](https://docs.aws.amazon.com/amazonglacier/latest/dev/checksum-calculations.html),
[retrieval ranges](https://docs.aws.amazon.com/amazonglacier/latest/dev/checksum-calculations-range.html),
[job output](https://docs.aws.amazon.com/amazonglacier/latest/dev/api-job-output-get.html),
[multipart limits](https://docs.aws.amazon.com/amazonglacier/latest/dev/uploading-archive-mpu.html), and
[completion semantics](https://docs.aws.amazon.com/amazonglacier/latest/dev/api-multipart-complete-upload.html).

## Benchmark workload

`deno task bench:glacier` samples one fixed 4 MiB + 13 byte image after complete-byte and independent Node SHA tree
preflight. Lanes separate a copy-only lower bound, native Node SHA tree reduction without a snapshot, WebCrypto linear
SHA without a tree, the public snapshotting tree utility, signed multipart upload, and completed-output reads with or
without a service checksum. The native and WebCrypto lanes use different crypto implementations and do not isolate a
single overhead.

The public tree utility owns one input snapshot. Client uploads already own their body image, so a private tree kernel
reuses it without another full snapshot; both retain logarithmic tree state plus WebCrypto digest temporaries. Output
lanes include Response construction and an exact output allocation. Bounded counters and one last request image replace
an accumulating sample history. All transport is in memory and every acquired response is retired. These lanes establish
no AWS throughput, network/TLS cost, retrieval latency, durability, process-startup result, or universal timing claim.
Measured results require a separate runtime/workload receipt.
