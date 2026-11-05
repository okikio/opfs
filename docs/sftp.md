# SFTP version 3

Read remote metadata, list a directory, or read and write finite file extents over a binary SFTP subsystem channel. The
application supplies that channel through its reviewed SSH transport. This module implements real SFTP packets; it does
not implement SSH authentication, cryptography or host-key verification.

This complete consumer function previews at most 4 KiB. The application supplies an authenticated channel factory and
owns credentials, host keys and recovery. Closing the client retires its channel and all remaining handles; a borrowed
parent SSH session remains application-owned.

```ts
import { openSftpClient } from "@okikio/opfs/sftp";
import type { SftpOptionsType, SftpReadType } from "@okikio/opfs/sftp";

export async function preview(
  openChannel: SftpOptionsType["openChannel"],
  path: string,
  signal: AbortSignal,
): Promise<SftpReadType> {
  const files = await openSftpClient({ openChannel, signal, timeoutMs: 15_000 });
  const primary: unknown[] = [];
  try {
    const file = await files.openFile(path);
    const result = await file.read(0, 4096);
    await file.close();
    return result;
  } catch (reason) {
    primary.push(reason);
    throw reason;
  } finally {
    try {
      await files.close();
    } catch (cleanup) {
      if (primary.length) throw new AggregateError([...primary, cleanup], "Preview and channel cleanup failed.");
      throw cleanup;
    }
  }
}
```

## Supply the authenticated subsystem

`openChannel({ subsystem: "sftp", signal })` acquires one exclusive channel with Web readable and writable byte streams
and idempotent asynchronous `close()`. It must return only binary subsystem stdout. SSH banners, a shell, diagnostics or
stderr cannot be mixed with SFTP packets. The factory owns partial and late acquisitions: it must honor abort and
dispose a channel produced after cancellation. A successfully returned channel transfers ownership to the SFTP client.

The injected transport owns host-key verification or pinning, user authentication, cipher and MAC selection, rekeying,
SSH channel establishment, flow-control windows, stderr, exit status and transport cleanup. It must surface transport
failure as a stream error. Closing this channel must retire pending reads/writes without disposing an independently
borrowed SSH connection. An implementation that ignores these requirements cannot provide the advertised cancellation
behavior. The core discovers no runtime modules, environment credentials, SSH agents, known-host files or SDKs.

One operation runs at a time; competing operations fail busy instead of queuing. Native requests use monotonically
allocated IDs without reuse or wrap and accept exactly one matching response. This initial profile does not pipeline
requests or claim high-latency throughput comparable to a pipelined native SSH client.

## Native files and metadata

| API                                   | Meaning                                                                                    |
| ------------------------------------- | ------------------------------------------------------------------------------------------ |
| `files.stat(path)`                    | Native `STAT`, which follows symbolic links.                                               |
| `files.stat(path, { follow: false })` | Native `LSTAT`, which describes the link itself.                                           |
| `files.list(path)`                    | Bounded `OPENDIR`/`READDIR` until explicit EOF, then acknowledged `CLOSE`.                 |
| `files.openFile(path, { mode })`      | Acquires an opaque server handle, with an explicit open mode below.                        |
| `file.stat()`                         | Native `FSTAT` on that open resource.                                                      |
| `file.read(at, length)`               | Bounded finite offset reads, returning `{ bytes, eof }`.                                   |
| `file.write(at, bytes)`               | Bounded offset writes, returning `{ at, bytes }` only after every `WRITE` is acknowledged. |
| `file.close()`                        | Sends `CLOSE`; a successful acknowledgement releases its handle budget.                    |
| `files.close()`                       | Retires the channel and every remaining handle; repeated calls share one completion.       |

Files and clients also implement `AsyncDisposable`. `maxOpenFiles` counts both file and temporary directory handles.
Each handle is private to its client and cannot be forged, edited or exported as protocol bytes. An empty opaque wire
handle is valid. Duplicate active wire handles are rejected because the client cannot assign independent ownership to
them safely.

Concurrent `file.close()` and asynchronous disposal share one admitted attempt. Its failure remains observable and does
not falsely mark the handle closed; dispose the client to retire that channel and its handles. A local busy or
pre-aborted admission does not become the disposal attempt, so the caller can try legitimate cleanup afterward.

| Open mode        | Native v3 flags           | Effect                                                    |
| ---------------- | ------------------------- | --------------------------------------------------------- |
| `read` (default) | `READ`                    | Opens an existing file for reading.                       |
| `write`          | `WRITE`                   | Opens an existing file for writing without truncating it. |
| `create`         | `WRITE`, `CREAT`, `EXCL`  | Creates a new file; refuses an existing path.             |
| `replace`        | `WRITE`, `CREAT`, `TRUNC` | Creates a file or truncates an existing file.             |

The client sends no explicit permission/owner attributes when opening. Server policy and its default creation mask
control access. Append, rename, removal, setstat, link mutation, fsync and other extensions are deferred. Extension
declarations are inspectable through `files.extensions`; advertising an extension does not cause this client to invoke
it or claim its guarantees.

Pathnames use an explicit UTF-8 profile. NUL and unpaired surrogates are refused; spaces, Unicode and other literal
characters are not shell-interpreted or normalized into a virtual path. A server filesystem can contain names outside
this UTF-8 profile; those are unsupported rather than silently replaced. Server authorization owns containment and
symbolic-link traversal. The client does not provide a sandbox by manipulating `..` or resolving aliases itself.

Listings return native names and structured `ATTRS`. They exclude `.` and `..` and reject returned child names with path
components. The unspecified `longname` presentation field is consumed but never parsed for attributes. Unknown or
missing file-type bits yield `kind: "unknown"`; known non-file/directory/symlink types yield `other`. Missing attributes
remain absent. Extended attributes are bounded opaque byte pairs. Modification/access times are native unsigned seconds,
not a monotonic version or a replay identity.

## Finite reads and acknowledged writes

Unlike FTP's suffix restart command, SFTP `READ` specifies an offset and a maximum length. The client issues bounded
chunks, advances by the actual returned bytes and continues after a short `DATA` response. `eof` becomes true only after
explicit `SSH_FX_EOF`, never merely because a short response arrived. A full requested extent has `eof: false` even when
it ends at the current file size; observing EOF requires another read. A zero-length local read returns empty bytes and
`eof: false` without sending `READ`. Zero-progress `DATA`, oversized data and unsafe uint64 values retire the channel
instead of being guessed into a result.

Reads and writes materialize at most their configured operation bounds. Wire chunks are at most 32 KiB and are reduced
further by the packet budget. Read accumulation and the returned trimmed array can temporarily hold two copies of the
operation's bytes, plus the bounded packet and transport buffers. Writes privately copy genuine `Uint8Array` bytes
before the first asynchronous step. Shared-backed views are accepted, but their caller owns synchronization during that
copy. The client does not stream an unbounded upload into memory.

An application can build a backpressured preview or transfer by requesting one finite extent after consuming the last.
The current API leaves that loop and its input/output stream ownership with the application. A single read operation
holds the session until its entire requested extent or explicit EOF has been received. There is no built-in stream
wrapper, checkpoint destination, `ByteSourceType`, immutable identity or stable snapshot claim. An open handle does not
prevent another client from changing the resource during successive reads.

`WRITE` success means that the server acknowledged all packets in that operation. It does not prove fsync, atomic
replacement, a content digest, or compare-and-swap publication. A later error can follow earlier acknowledged writes; a
negative status is not evidence that the file remained unchanged. Missing or malformed completion after dispatched
mutating `OPEN`, `WRITE`, or a dirty handle's `CLOSE` yields `SftpPublicationError`. Inspect remote state before
retrying. Local request-budget admission before dispatch is not mislabeled unknown publication. No mutation is retried
automatically.

## Limits and failure recovery

The default operation deadline is 30 seconds, configurable through positive integer `timeoutMs` up to one day. The
client-level signal remains authoritative for later operations; methods may add an operation signal. `cleanupMs`
separately bounds channel-close waiting to 5 seconds by default, at most 60 seconds. A broken injected transport may
continue work after that wait; the client reports the failure and cannot force arbitrary foreign code to release it.
Cleanup failures remain available with the primary error in an aggregate.

Known, completely decoded server statuses use `SftpError.status` and preserve session alignment. Error messages omit
untrusted server text. Malformed packets, unexpected IDs/types, unknown attribute flags, cancellation, deadlines and
transport failures retire the channel and invalidate all handles. A failed temporary directory close also retires it;
the directory handle cannot be handed back to the caller for recovery. Closing the channel is distinct from sending and
acknowledging every open file's `CLOSE`; explicitly close writable files when their acknowledgement matters.

| Policy                                                        |    Default |      Maximum accepted |
| ------------------------------------------------------------- | ---------: | --------------------: |
| `maxPacketBytes` (length field, excluding its own four bytes) |    256 KiB | 8 MiB (minimum 1 KiB) |
| `maxChunkBytes`                                               |     64 KiB |                 8 MiB |
| `maxReadBytes` / `maxWriteBytes`                              | 8 MiB each |           64 MiB each |
| `maxPathBytes`                                                |      8 KiB |                 1 MiB |
| `maxListBytes`                                                |      8 MiB |                64 MiB |
| `maxEntries` (wire names, including `.`/`..`)                 |    100,000 |             1,000,000 |
| `maxOpenFiles`                                                |         16 |                 1,024 |
| `maxRequests` per session                                     |  1,000,000 |         4,294,967,295 |

Server uint64 offsets/sizes are parsed without losing precision and refused above JavaScript's safe-integer range.
Native handles are at most 256 bytes under v3. Extension declarations and extended attributes have independent caps of
128 records, with bounded names. Empty transport chunks are limited to prevent no-progress loops. Local packet, path and
operation bounds all apply; increasing one does not increase the others. These are implementation safety policies, not
automatically negotiated server limits.

## Protocol and proof

This is the deployed v3 profile described in the expired
[filexfer-02 draft](https://www.ietf.org/archive/id/draft-ietf-secsh-filexfer-02.txt), which
[OpenSSH explicitly implements](https://github.com/openssh/openssh-portable/blob/V_10_2_P1/PROTOCOL). It is not a claim
to implement a newer filexfer draft. SSH subsystem establishment belongs to the transport under
[RFC4254 section 6.5](https://www.rfc-editor.org/rfc/rfc4254.html#section-6.5).

`tests/sftp.test.ts` independently encodes protocol vectors for framing, attributes, finite short reads, EOF, handle
limits, response identity, cancellation and ambiguous mutations. `tests/provider/sftp.ts` pins a maintained
LinuxServer/OpenSSH image by immutable index digest. Testcontainers owns its lifecycle, ephemeral mapped port and
resource limit; no host data or ambient SSH credentials are mounted. Keys are generated inside the fixture. Its native
OpenSSH client uses a fixture-owned known-host record and strict verification to open the real `sftp` subsystem, while
the independent `sftp` CLI produces and verifies files. The test transport uses `docker exec -i` and requires Docker's
CLI as well as its daemon. That lane tests the packet client against a real server and the fixture's SSH transport; it
cannot validate a different application-supplied transport or all SFTP servers.
