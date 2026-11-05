# Native JetStream messages

`NatsClient` publishes bounded binary payloads to an existing JetStream stream and retrieves a stored message by its
native sequence. Your application supplies the transport and owns the stream's permissions, subjects, retention,
replication and durability configuration. This profile does not turn Core NATS into durable storage or project messages
as files.

This complete consumer function takes a channel capability and two caller-owned unique inbox subjects. It publishes
bytes, then reads the acknowledged sequence. Each operation acquires and closes its own connection, including on
failure, so the application does not close a retained client connection:

```ts
import { NatsClient } from "@okikio/opfs/nats";
import type { NatsChannelType, NatsMessageType } from "@okikio/opfs/nats";

export async function save(
  openChannel: (options: { readonly signal: AbortSignal }) => Promise<NatsChannelType>,
  token: string,
  bytes: Uint8Array,
  publishInbox: string,
  readInbox: string,
): Promise<NatsMessageType> {
  const client = new NatsClient({ openChannel, auth: { token } });
  const receipt = await client.publish("ORDERS", "orders.new", bytes, { inbox: publishInbox });
  try {
    return await client.get(receipt.stream, receipt.sequence, { inbox: readInbox });
  } catch (reason) {
    throw new Error("Publication was acknowledged, but the later read failed.", { cause: { receipt, reason } });
  }
}
```

The example retains the publication receipt in the later read error's `cause`; that read failure does not erase the
acknowledged publication. A later read can fail even after publication succeeded: stream retention, deletion,
administrative changes or stream recreation can remove the message. A sequence identifies a position in the native
stream; it is not an independently verified immutable storage identity. There is no filesystem, generic record driver or
`ByteSource` projection.

## Request and channel ownership

The `openChannel` function must acquire a fresh exclusive NATS channel positioned at its initial server `INFO`. It must
honor the supplied signal and close partial or late connections rather than returning them after cancellation. A
successful acquisition transfers ownership. The channel's idempotent `close()` retires pending reads and writes. The
client can bound its wait for a broken adapter; it cannot force arbitrary injected code to release a resource.

The adapter reports `security: "plaintext"` or `"tls"`. The adapter owns socket routing, TLS negotiation, certificate
verification and peer authentication. A TLS adapter must preserve the initial INFO after negotiation. The client refuses
a server's `tls_required` flag on a plaintext channel before sending CONNECT credentials. A false flag does not make
plaintext safe: your deployment must select an appropriately protected transport. There is no automatic STARTTLS,
credential discovery, runtime socket import, NKey/JWT signer, endpoint fallback or CONNECT-URL discovery. Native server
addresses in INFO remain inert data.

`NatsClient` captures the `openChannel` method and optional token or user/password strings during construction. It does
not perform IO until a method is called. Caller strings and byte inputs are admitted and privately copied before
asynchronous callbacks. This implementation does not promise secure memory erasure.

Each request supplies an exact non-wildcard reply subject with `inbox`. The caller owns uniqueness, account isolation
and permission to subscribe to that namespace. Never reuse it for another in-flight request, overlap it with a stream's
published subjects or let an untrusted principal publish replies there. The request inbox must differ from the request
subject. The fixed subscription SID `1` belongs only to this request's exclusive connection; both the reply subject and
SID are checked. A secret-looking inbox is not independent authentication of a publisher.

CONNECT explicitly identifies `lang: "typescript"` and wire-profile `version: "opfs-nats/1"` (not the package release
version), and sets `tls_required` from the adapter's declared transport security. External envelopes allow unknown
fields for compatibility, while selected identity, error and acknowledgement authority is validated. Contradictory
acknowledgement/error envelopes are refused.

The client consumes INFO, sends CONNECT and waits for a PING/PONG authentication barrier. It then subscribes once,
auto-unsubscribes after one message and sends a single native request. It answers bounded server PING and admits bounded
INFO updates without reconnecting. Unsolicited controls, framing and the deadline are finite. There are no background
subscriptions, queues, pipelining or reconnect retries.

## Native bytes and receipts

`get(stream, sequence, { inbox, signal? })` requests `$JS.API.STREAM.MSG.GET.<stream>`. The stream is a selected
single-token name and sequence is canonical positive uint64 decimal text. The result retains the native subject,
sequence and raw server timestamp declaration, including nanosecond fractions, without converting it to a JavaScript
`Date`. The timestamp is checked only for RFC3339 shape; calendar validity, clock accuracy and timestamp authenticity
are not established. Payload and stored headers are private byte copies. Headers remain inert bytes: the client does not
apply compression, content decoders or application policy. Reading does not create or advance a consumer, acknowledge a
delivery, or pin retention.

`publish(stream, subject, bytes, { inbox, messageId?, signal? })` sends HPUB with `Nats-Expected-Stream` set to the
requested stream. This is a native admission precondition, in addition to checking the stream named in the returned
acknowledgement. The optional `messageId` sends `Nats-Msg-Id`. An attributed receipt contains native stream, uint64
sequence and `duplicate`; native deduplication is limited to the configured stream window, not perpetual exactly-once
publication. The client does not retry automatically. An acknowledgement's durability depends on the stream's actual
configuration and server behavior; this API does not infer replication, fsync or retention policy.

The selected subject profile is visible ASCII, at most 1024 characters, with no empty dot tokens, wildcards, whitespace
or backslashes. Stream names additionally have no dot or slash. Credential and message-ID strings have a 4096-character
visible-ASCII policy. Payload defaults to, and cannot exceed, 1 MiB; `maxBytes` can lower it. Empty payloads are valid.
These are local implementation limits, not claims about the server's full native capacity.

Before publication the complete native payload plus headers must fit the advertised `max_payload`. The response frame
cap is 2 MiB, stored-header cap is 64 KiB, control-line cap is 8192 bytes and incoming-chunk cap is 64 KiB. Adapters
must supply suitably bounded chunks. Sixteen consecutive empty chunks are permitted before the next is refused. Initial
controls are capped at 32; response controls at 128. Header blocks have at most 128 fields. JSON is bounded in size,
depth and token count, rejects duplicate/prototype keys and preserves integer lexemes as bigint until semantic
admission. Public sequences remain decimal strings. Fractional or exponent numeric spellings are refused rather than
rounded; base64 must use canonical padded RFC4648 spelling.

## Failure and recovery

The default whole-operation deadline is 30 seconds, at most one day. `timeoutMs` covers acquisition, authentication and
reply, while `cleanupMs` bounds adapter retirement separately (default five seconds, at most one minute). Optional
constructor and operation signals add cancellation. Invalid local input and a pre-aborted signal acquire no channel.
Each admitted operation closes its channel and releases stream locks on every terminal path.

`NatsError` represents an admitted native refusal with a bounded code; it does not echo server descriptions or
credentials. An attributed JetStream API error or exact no-responders status is a native refusal. A generic protocol
`-ERR` observed after publication is insufficient to establish non-publication: it may describe the preceding SUB while
the later PUB still stores data. That case remains uncertain. Errors thrown by an injected adapter remain their original
causes and may contain details supplied by the adapter.

`NatsPublicationError` has `outcome: "unknown"`. A publication was dispatched without an admitted attributable terminal
acknowledgement. Timeout, cancellation, disconnect, malformed receipt or an unrelated stream in the receipt does not
prove no effect. Do not blindly retry. Reconcile with a fresh request and your application ownership/deduplication
policy; a later equal payload or message-ID observation alone does not establish a particular writer's history outside
the native deduplication window.

`NatsCompletionError.receipt` preserves a fully admitted message or publish acknowledgement when later cancellation or
independent cleanup fails. Its cause retains the actual terminal failure. A known native refusal and independent cleanup
failure are retained together, without relabeling the refusal as an unknown publication. The caller must distinguish a
completed operation with failed cleanup from one whose publication outcome is unknown.

## Contract sources and proof boundary

The primary contracts are the [official NATS client protocol](https://docs.nats.io/reference/protocols/client) and
[JetStream request/reply API](https://docs.nats.io/reference/jetstream/api/). Source research pins NATS Server 2.15.2 at
`5a815f11a911efa2c88fd1dbfb18ed89a449bfc1`, including the stored-message schema and native expected-stream admission in
`server/jetstream_api.go` and `server/stream.go`. Independent oracle research pins nats-py 2.16.0 at
`3547a63b2658db4596928668d75fab7c673f6fe6`. Both use Apache-2.0; no server or SDK implementation is copied into
production. Production uses existing project-owned bytes/cleanup primitives, Zod and approved standard-library base64
codecs.

All fifteen authored protocol cases passed separately on Deno, Node and Bun in an offline 1 GiB RAM/swap-ceiling,
one-CPU, PID-128 runner, including the INFO/PONG/SUB cancellation boundaries. Owned formatting and lint passed. The
first check stopped at two control-character regex lint refusals before any protocol tests ran; equivalent visible-ASCII
allowlists repaired those refusals. These runtime checks do not replace isolated type/package validation.

The first disposable native run also passed against NATS Server 2.15.2 and the independent official nats-py 2.16.0 SDK
on Python 3.13.12. It checked all six-byte and 128 KiB originals in both directions, deduplication acknowledgements,
missing-sequence and authentication refusal, and native expected-stream rejection with independent confirmation that the
other stream remained empty.

This qualifies only the selected single-node Memory-storage profile; TLS, cluster replication, fsync and retention
behavior are not established. Both server and SDK containers had an actual 256 MiB RAM/swap ceiling, half a CPU, PID
128, private fixture credentials and no host bind; the server had a bounded 16 MiB temporary filesystem. Testcontainers
12.1.0 owns lifecycle. Actual created-state resource admission precedes engine start and post-start limits are checked
again. All owned resources closed and the exact task-label query found no remaining containers. Raw server responses
have not been rewritten.

The separate candidate-independent capture now retains the actual native asynchronous INFO update and exact MSG replies.
Its literal producer checked all six official-SDK-original bytes before the read and after publication; package
consumers can replay the unchanged control frames, payload envelope and acknowledgement without starting a server. The
helper initially assumed MSG followed immediately; a diagnostic retry identified INFO, and a bounded control loop
repaired only the capture helper. The first attempt retains source/input/exit evidence but its full log was accidentally
overwritten; the diagnostic and successful attempts retain full logs. Capture provenance names that evidence gap
explicitly.

The two captured-fixture lanes also ran once on Node 26.13.0, Linux arm64, with one CPU, a 1 GiB RAM/swap ceiling, PID
128 and no network or host mounts. Both acquire a fresh Webstreams channel and perform the handshake for every request.
The raw fixed-offset JSON/base64 lower bound averaged about 10.7 µs; the strict client averaged about 983 µs for this
679-byte reply and six-byte original. These samples include local framing, control validation and ownership costs. They
do not measure a deployed server or equivalent validation, and should not predict application throughput. The complete
report is losslessly compressed beside its input, runtime and resource receipt in `tests/fixtures/nats/benchmark.json`.
Sixteen portable cases, including exact native replay, now pass on all three runtimes. The first replay check exposed
only an authored expected CONNECT property-order mismatch; production and native wire evidence were unchanged by its
repair.

Stream administration, durable consumers, pull/ack delivery, clustering, failover, WebSocket, NKey/JWT, streaming
payloads and complete NATS support remain outside this first profile.
