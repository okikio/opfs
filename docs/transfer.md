# Upload, pause and resume a fixed source

Use `tus` for an upload endpoint and `transfer` for checkpoint-resumable copying. An upload endpoint is not a
filesystem: it need not support downloads, directories or listing. The source and destination remain independently
usable. Both modules require explicit construction and perform no network work on import.

This complete in-memory example creates a tus upload and saves its acknowledged checkpoints. Replace the URL with your
endpoint and supply its authentication headers explicitly. The remote server must advertise the creation extension.

```ts
import { createTusClient } from "@okikio/opfs/tus";
import { createTransferCheckpoint, resumeTransfer } from "@okikio/opfs/transfer";
import type { TransferCheckpointType } from "@okikio/opfs/transfer";

const bytes = new TextEncoder().encode("hello resumable upload");
const source = {
  identity: "application-owned-immutable-content-v1",
  size: bytes.byteLength,
  async read(offset: number, length: number) {
    return bytes.slice(offset, offset + length);
  },
};
const client = createTusClient({ endpoint: "https://uploads.example/files" });
const destination = await client.create(source.size, { filename: "hello.txt" });
let checkpoint: TransferCheckpointType = createTransferCheckpoint(source, destination);

// This example keeps state in memory. An application must atomically save it to
// durable storage before it can promise recovery after the application exits.
const save = async (value: TransferCheckpointType) => {
  checkpoint = value;
};
await save(checkpoint);
const result = await resumeTransfer({ source, destination, checkpoint, save, chunkBytes: 1024 * 1024 });
console.log(result.state, result.offset); // completed, source.size
```

The caller gives this source an identity and guarantees that every read returns the same bytes for that identity. In a
real application, bind it to an immutable object generation, a separately verified content digest or an equivalent
snapshot contract. An arbitrary filename, size or mutable Blob wrapper is insufficient to prove unchanged contents.
Changing transform parameters, encryption context or ciphertext changes the replay source: use a new identity and upload
session. A checkpoint does not store encryption keys or reconstruct an arbitrary decoder state.

## Restart with the saved checkpoint

Keep the checkpoint in application-owned storage using atomic publication. On restart, parse it with
`TransferCheckpointSchema.parse(savedData)`, reopen the same immutable source, and call
`client.open(checkpoint.destination)`. Then pass both into `resumeTransfer()` as above. Configure the same endpoint and
authentication policy; an upload URL itself can be a bearer secret. Do not log checkpoints indiscriminately.

The continuation checks source identity, size, destination URL, protocol and checkpoint version before reading the
source or contacting the destination. It then reads the server's retained offset. Each chunk follows this order:

```text
read exact source range -> send chunk -> check exact acknowledgment -> atomically save checkpoint
```

After the last chunk, the library separately confirms final publication. A destination can acknowledge every byte while
still staging an unpublished object. Its status must report `complete: true`, or its explicit `finish()` must publish
and return that confirmation, before a completed checkpoint is saved. An empty upload needs this confirmation too. A
missing publication receipt leaves the checkpoint active, even when its offset equals its size.

If the server accepted bytes but the process exited before saving, its offset can be ahead of the checkpoint. Under
exclusive session ownership, the library reconciles that offset and continues from it. If the server is behind a saved
offset, has a different length, or reports an invalid offset, continuation fails. Never restart blindly at the last
local offset after an unknown PATCH result. Resume again to query the server first. No PATCH or POST is retried
automatically.

Only one writer may own the session. The library does not provide a distributed lease, fence competing application
instances, prove that another writer uploaded matching bytes, or orchestrate background retries. Applications needing
concurrent ownership must add an external authority. Source identity and an offset are not content-integrity proofs.

Creation has its own uncertainty window: if POST succeeds but its Location response is lost, this client cannot recover
the unknown URL. It will not silently create a second upload. Application metadata or a service-specific lookup and
cleanup policy may resolve that case. Missing or expired uploads fail explicitly; starting over is an application
choice.

## Pause, abort and cancel have different effects

Pass `pause: () => requestedPause` to save a paused checkpoint at the next acknowledged chunk boundary. Call
`resumeTransfer()` with that checkpoint to continue. An `AbortSignal` stops active source/transport work cooperatively;
remote bytes may already have been committed, so reconcile on the next continuation. Neither action deletes remote
state.

`cancelTransfer(destination, checkpoint, save)` requests explicit remote termination and saves `cancelled` only after
its acknowledgment. The tus client checks the advertised termination extension first. A failed deletion or checkpoint
save requires reconciliation; do not assume the remote upload survived. Disposal of a borrowed source or client is still
the application's responsibility. No timer, worker or remote cleanup starts in the background.

## Bounds, extensions and third-party destinations

Transfer chunks default to 8 MiB and admit 1 byte through 64 MiB. At most one source read and destination write is
active. The tus request copies that chunk into an owned ArrayBuffer for Fetch; account for source plus transport
buffering. Fetch and the server may retain additional bytes. A hard CPU deadline is not promised. Save rejection stops
the operation before another chunk is read. A source returning an inexact range or destination acknowledging a different
extent fails.

`TusClient` implements tus 1.0 core, known-length creation and negotiated termination. It exposes expiration metadata
returned by HEAD, without reading a clock or assuming expiration has not changed. Deferred length, creation-with-upload,
checksum negotiation and concatenation are not implemented. Discovery returns server advertisements; it does not claim
the client supports every advertised extension. It checks response versions, status codes and safe-integer offsets and
cancels unexpected response bodies without downloading them. Metadata has an 8 KiB implementation header ceiling.

Upload URLs default to the endpoint origin. Explicitly provide `allowUploadURL` when your server intentionally creates
cross-origin resources, and make the `headers(url)` callback apply credentials only to authorized targets. Redirects
fail rather than forwarding credentials. Fetch credentials default to `omit`; choose `credentials` explicitly when a
browser deployment intentionally uses cookies or client certificates. CORS and the server's permissions remain
deployment responsibilities.

A third-party destination implements `UploadDestinationType`: fixed protocol/URL identity, explicit status
reconciliation, exact acknowledged writes, optional final publication and optional termination. Its status must
represent server-retained bytes plus explicit publication completion, and its write must not resolve on merely queued
local progress. Use `TransferCheckpointSchema` for persisted data. This generic contract does not turn block-staging,
multipart completion or an unknown-length session into a tus upload; the provider adapter must implement its actual
acknowledgment and final-publication rules.

Portable tests cover protocol admission, changed identities, rollback, failed saves, pause, cancellation, bounded reads
and acknowledgment mismatches. A separate process test exits after persisting destination bytes but before the
checkpoint, then starts a fresh process and verifies continuation without duplicate output. These tests use authored
fixtures; they do not establish interoperability with a hosted tus service or a real cloud provider.
