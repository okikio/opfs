# FTP and explicit FTPS

Use the native client when an application already owns TCP sockets and, for FTPS, a certificate-validating TLS
implementation. The core imports no Node or Deno networking module and discovers no credentials. A browser without a
socket capability cannot use this protocol through Fetch.

This complete consumer function downloads one file into an application-supplied destination. It transfers ownership of
that destination to `pipeTo`, which closes it on success and aborts it on failure. The application supplies the
transport described below; it also owns credentials and UI recovery.

```ts
import { openFtpClient } from "@okikio/opfs/ftp";
import type { FtpReceiptType, FtpTransportType } from "@okikio/opfs/ftp";

export async function download(
  transport: FtpTransportType,
  credentials: { host: string; username: string; password: string },
  path: string,
  destination: WritableStream<Uint8Array>,
  signal: AbortSignal,
): Promise<FtpReceiptType> {
  const files = await openFtpClient({
    ...credentials,
    transport,
    mode: "explicit-tls",
    timeoutMs: 60_000,
    signal,
  });
  const primary: unknown[] = [];
  try {
    const transfer = await files.openRead(path);
    await transfer.stream.pipeTo(destination, { signal });
    return await transfer.done;
  } catch (reason) {
    primary.push(reason);
    throw reason;
  } finally {
    try {
      await files.close();
    } catch (cleanup) {
      if (primary.length) throw new AggregateError([...primary, cleanup], "Download and connection cleanup failed.");
      throw cleanup;
    }
  }
}
```

## Supply a socket capability

`FtpTransportType.connect({ host, port, signal })` returns a connection with Web readable/writable byte streams, its
concrete connected `peerAddress`, and idempotent asynchronous `close()`. The client owns each successfully acquired
connection. The application retains ownership of the transport factory. A failed or aborted connection attempt must
dispose its own partial or late acquisition.

Streams must be lazy and backpressured. In particular, a plaintext readable stream must stop observing socket bytes when
its reader is released for `AUTH TLS`; it cannot retain an eager data listener that consumes encrypted bytes. The
control parser releases its reader only after the complete `234` reply and refuses buffered plaintext at this boundary.
The injected capability owns the actual socket-to-stream conversion.

`secure(socket, { serverName, role, controlSecurity, signal })` performs the TLS client handshake and returns
`{ socket, context }`. It must validate the certificate chain and original configured hostname. For a data connection,
it receives the control handshake's opaque `context` as `controlSecurity`. The capability owns authenticated binding
between the control and data connections, including TLS-session resumption when required by the server or application.
It must report TLS truncation or other failed authenticated termination as an error, rather than ordinary data EOF. The
protocol core cannot inspect or certify these properties of a foreign TLS implementation.

Successful TLS upgrade transfers ownership to the returned socket; a failed upgrade leaves the original socket with the
client for disposal. Like `connect`, `secure` must honor abort and dispose a late protected socket even when its
handshake completed after the operation deadline. `close()` must retire blocked reads/writes, not just stop accepting
new operations. A runtime adapter that does not honor those contracts cannot provide reliable cancellation. The
test-only Node adapter in `tests/provider/ftp.ts` illustrates lazy streams and certificate validation; it is not a
published runtime adapter.

`mode: "explicit-tls"` requires this TLS capability. The client accepts `220`, sends `AUTH TLS`, requires `234`, then
performs the handshake before sending credentials. It sends `PBSZ 0` and `PROT P` before opening any data channel. It
never falls back to plaintext, sends `CCC`, or switches to `PROT C`. `mode: "plain"` is a separate explicit choice.
Implicit FTPS is outside this profile.

## Read, list and upload

| Operation                            | Behavior                                                                                             |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| `stat(path)`                         | Requires advertised `MLST`; returns one structured fact record.                                      |
| `list(path)`                         | Requires advertised `MLST`/`MLSD`; materializes a bounded listing and removes `cdir`/`pdir` records. |
| `openRead(path, { offset, signal })` | Returns a streaming suffix download, a completion promise and explicit cancellation.                 |
| `put(path, bytes, { signal })`       | Sends a bounded, privately copied `Uint8Array` using `STOR`; may replace existing content.           |
| `close()`                            | Aborts active work and closes acquired sockets; repeated calls share the same completion.            |

Login supports `USER` returning `230`, or `331` followed by `PASS` returning `230`. Account negotiation is unsupported.
Binary stream mode is selected through `TYPE I`, `MODE S` and `STRU F`. Commands reject CR, LF, NUL, other controls,
unpaired surrogates and oversized arguments before sending bytes. Credentials use the initial ASCII profile. Pathnames
can use UTF-8 only when the server advertises `UTF8`. Spaces are literal and are not trimmed. No raw command API is
provided.

Listings use RFC3659 facts, with no locale-sensitive `LIST` fallback. `size` is a safe nonnegative integer when present;
`modify`, `unique` and other facts remain descriptive strings. Names are native server names, not normalized virtual
paths. Unknown native resource types remain visible in `type`. This client does not project listings into an OPFS
filesystem or promise that repeated listings describe a stable snapshot.

Passive transfers use `EPSV` exclusively. Its reply supplies only a port; the destination address is pinned to the
actual control connection's concrete peer. The returned data socket must report the same peer address. The TLS
certificate name remains the original configured hostname. There is no active-mode, `PASV`, server-selected host, proxy
transfer or FXP fallback.

`REST` selects a starting offset, not an ending offset. A nonzero offset requires advertised `REST STREAM` and a `350`
reply before `RETR`. The stream continues to remote EOF. To preview a prefix, read the needed bytes, then call
`transfer.cancel(reason)` even if the stream is locked by your reader. This retires the whole control session; open a
new client for later operations. Early cancellation is incomplete, not a successful download receipt. No immutable
identity, finite wire range, checkpoint replay, `ByteSourceType`, or resumable `UploadDestinationType` is claimed from
`SIZE`, `MDTM` or MLSx `unique` metadata.

`transfer.done` resolves only after both data EOF and final `226`/`250`. Normal stream completion also waits for that
reply, so `pipeTo` cannot report success merely because the server closed the data connection. A negative terminal reply
is observed while data is still pending. The promise has an internal rejection observer so cancellation does not create
an unhandled rejection when a preview consumer intentionally ignores the receipt; callers should still await it when
they need the result.

Upload bytes are copied before the first asynchronous step. Native byte admission accepts genuine cross-realm and
shared-backed `Uint8Array` views; callers must synchronize shared memory during the copy. Each write respects the data
socket's backpressure. Streaming uploads, `APPE`, upload restart, rename and deletion are deferred. `STOR` supplies no
compare-and-swap condition, atomic replacement or verified digest. A success receipt reports bytes sent and server
completion, not durable storage. A negative completion can still leave partial remote content. If `STOR` was dispatched
and completion is unknown, `FtpPublicationError` instructs the caller to inspect remote state; do not blindly retry.

## Limits, cancellation and recovery

One session admits one operation or active transfer at a time. Competing operations fail with a busy error instead of
entering an unbounded queue. An open download holds the session until it completes or is cancelled. An operation failure
retires the connection to prevent later commands from consuming stale replies. Local argument admission errors and the
preflight refusal of an unsupported listing do not send a command.

The default operation deadline is 30 seconds; `timeoutMs` can select a positive integer up to one day. It covers the
entire operation, including idle time waiting for the download consumer. The client-level signal remains authoritative
for later operations; individual operations may supply an additional signal. A timeout or abort retires the session.
Closing each socket has a separate `cleanupMs` budget of 5 seconds by default, at most 60 seconds. A broken capability
can continue its own work after that bounded wait; the client reports the failure and cannot force a foreign runtime to
release resources. Independent cleanup failures are retained with the primary failure in an aggregate.

| Policy           | Default | Maximum accepted |
| ---------------- | ------: | ---------------: |
| `maxLineBytes`   |   8 KiB |            1 MiB |
| `maxReplyBytes`  |  64 KiB |            8 MiB |
| `maxChunkBytes`  |  64 KiB |            8 MiB |
| `maxUploadBytes` |   8 MiB |            1 GiB |
| `maxListBytes`   |   8 MiB |           64 MiB |
| `maxEntries`     | 100,000 |        1,000,000 |

These are local implementation/policy bounds, not FTP provider limits. The control parser rejects bare LF, invalid
multiline framing and Telnet negotiation bytes. Servers requiring Telnet negotiation are unsupported by this profile.
Downloads are streamed rather than accumulated; total download size is not bounded by `maxUploadBytes` or
`maxListBytes`. Chunk admission and the operation deadline still apply.

## Standards and evidence

The implementation follows [RFC959](https://www.rfc-editor.org/rfc/rfc959.html),
[EPSV in RFC2428](https://www.rfc-editor.org/rfc/rfc2428.html),
[MLSx and REST STREAM in RFC3659](https://www.rfc-editor.org/rfc/rfc3659.html), and
[explicit TLS in RFC4217](https://www.rfc-editor.org/rfc/rfc4217.txt). SFTP is a distinct SSH subsystem and is not
implemented by this module.

`tests/ftp.test.ts` uses scripted protocol bytes for framing, budgets, injection, suffix semantics, final reply
ordering, cancellation, deadline, snapshot and unknown-publication checks. Its TLS substitute proves command order only.
The separate [Testcontainers fixture](../tests/fixtures/ftp/README.md) now configures unprivileged native ProFTPD from
an immutable official Node base with signed Debian packages. Native libcurl produces and checks files. Its new real-PWD
namespace uses native directory operation restrictions, with outside-home denial checks; it makes no chroot claim. The
current native fixture passed all five provider cases: plain protocol reads, independent full-byte upload readback,
trusted TLS1.2 with both data sessions reused, untrusted-certificate refusal, and outside-home operation refusals. The
historical pyftpdlib/ftplib recipe remains an inert snapshot with a different namespace contract. The fixture maps its
two private passive ports to their ephemeral host ports only inside the injected test transport; production peer pinning
is unchanged. The real TLS lane validates its test CA, requires data-session resumption and deliberately restricts the
fixture to TLS1.2; it does not prove other TLS versions, all servers, or a consumer's injected transport.
