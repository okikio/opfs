# Google Cloud Pub/Sub messages

Use this native REST client when an application owns topics and subscriptions and needs to publish opaque bytes or
receive and settle bounded message batches. Pulling acquires delivery state. Acknowledgement changes that state; it is
not a file deletion or proof that application processing happened exactly once.

This example processes each returned message before explicitly acknowledging its delivery. If processing or
acknowledgement fails, the function stops. Other returned messages remain unacknowledged, and the caller owns recovery.

```ts
import { createPubsubClient } from "@okikio/opfs/pubsub";
import type { PubsubDeliveryType } from "@okikio/opfs/pubsub";

export async function receiveBatch(
  project: string,
  subscription: string,
  accessToken: string,
  consume: (delivery: PubsubDeliveryType) => Promise<void>,
): Promise<number> {
  const client = createPubsubClient({
    endpoint: "https://pubsub.googleapis.com/",
    project,
    fetch: globalThis.fetch.bind(globalThis),
    credentials: () => ({ authorization: `Bearer ${accessToken}` }),
  });
  const deliveries = await client.pull(subscription, { maxMessages: 10 });
  for (const delivery of deliveries) {
    await consume(delivery);
    await client.acknowledge(subscription, [delivery.ackId]);
  }
  return deliveries.length;
}
```

The caller owns project selection, topic/subscription provisioning, OAuth scope and IAM permissions, processing
idempotency, and the acknowledgement decision. Construction performs only local validation. Fetch and credentials are
borrowed capabilities; this client acquires no connection pool or background task and needs no disposal. It performs no
environment, account, token or endpoint discovery. There is no record driver, filesystem projection or immutable byte
source: message delivery is a different contract from a path-addressable retained object.

## Publish and receive complete bounded bytes

`publish(topic, messages)` accepts a finite array of `{ bytes?, attributes? }`. Every message must contain nonempty
bytes or at least one attribute. Attribute-only messages, including an attribute with an empty string value, are valid.
The client snapshots byte views and attribute strings before awaiting credentials. Publishers cannot supply a server
message ID, publication timestamp or other extra field. This initial publishing profile does not expose ordering keys.
`PubsubMessageSchema` describes the selected message data grammar; actual operation policies also bound the whole batch.

The result is an array of opaque message-ID strings in request order. A response with a missing, duplicate or incorrect
number of IDs is an uncertain publication, not a partial success list. A successful publish receipt does not prove that
any subscriber received or processed a message. IDs are scoped to the topic; they are not content hashes or globally
unique storage revisions.

`pull(subscription, { maxMessages })` returns a finite array of deliveries. Each delivery has caller-owned `bytes`,
immutable attribute strings, `messageId`, a nanosecond-preserving UTC `publishTime` string and its `ackId`. Native
`orderingKey` and best-effort `deliveryAttempt` are preserved when supplied. Returning an ordering key does not
implement ordered publishing, ordered concurrent processing or deduplication. There is no streaming pull or hidden
consumer loop.

An omitted, null or empty `receivedMessages` field, or an empty successful JSON response body, returns an empty array. A
smaller or empty array does not establish that the backlog is empty. The service can return fewer messages than
requested even when more are available. A caller-selected deadline can also end a long pull before any response arrives.

## Delivery settlement belongs to the application

An acknowledgement ID identifies a delivery under one subscription. It is distinct from the topic's message ID. Keep its
subscription context when persisting it, and do not reuse it as an object identity, publication receipt or idempotency
key. The client does not retain or discover delivery tokens.

`acknowledge(subscription, ackIds)` sends only the explicit finite token list. Its successful empty native receipt is
not a promise of permanent non-redelivery: an expired acknowledgement may succeed and the message can still be
redelivered. Exactly-once delivery requires separate service and subscription configuration; this unary profile makes no
such guarantee and does not implement acknowledgement confirmation protocols.

`modifyAckDeadline(subscription, ackIds, seconds)` makes one explicit change from 0 through 600 seconds relative to
server receipt. Zero requests immediate availability for redelivery. There is no automatic renewal, local clock
translation, lease-preservation policy or sleeping retry. A deadline change does not record that the application
finished its work. The caller owns how much work to admit and how to settle or abandon every delivered message.

## Cancellation, errors and recovery

All four operations mutate service state, including `pull`. No request is automatically retried. Preaborted or invalid
work stops before credential acquisition or dispatch. Caller cancellation and `timeoutMs` apply to credential
preparation, Fetch and the owned response reader. The default is 60 seconds and the local maximum is five minutes.
Borrowed capabilities must honor cancellation; arbitrary callback side effects remain their owner's responsibility.

`PubsubError.status` records a sanitized non-success HTTP status without copying foreign body text. A definite native
4xx refusal, excluding ambiguous HTTP 408 and 429, remains a refusal even if unused-response cleanup independently
fails; both failures are retained. Redirects are refused with `redirect: "manual"`, and credentials never follow them.

A dispatched request without a complete attributable success/refusal raises `PubsubOutcomeError`, with
`outcome: "unknown"`, `operation`, the full native resource name and the original `cause`. This includes lost responses,
malformed success JSON, incomplete publication IDs, and incomplete delivery/settlement receipts. A lost publish reply
can conceal a successful publication; repeating it can create duplicates. A lost pull reply can conceal acquired
deliveries, while a lost acknowledgement or deadline reply can conceal successful settlement. Reconcile with the
application's durable processing/idempotency state and native delivery behavior before deciding what to repeat. The
library provides no query that can attribute equal bytes to the original uncertain publish.

Library-owned errors omit message data, bearer tokens, acknowledgement IDs and foreign reason text. Caller-injected
Fetch/credential failures may contain their own sensitive details, and original causes remain available. Applications
own safe error logging. The uncertain-outcome error deliberately retains the native resource name for recovery.

## Selected profile and local bounds

The API endpoint is one explicit HTTP(S) origin with root path, no embedded credentials, query or fragment. HTTPS is
required unless `allowHttp: true` explicitly selects an emulator. Projects use the 6–30-character lowercase project-ID
profile, not numeric project aliases. Topic/subscription IDs are literal native names, 3–255 ASCII characters beginning
with a letter and using letters, digits, hyphen, underscore, dot, tilde, plus or percent. The reserved `goog` prefix is
refused. Each name is encoded once, so literal percent/plus are not interpreted as URL syntax. Credentials receive a
detached URL and may supply only `Authorization`; they cannot alter the target, body, conditions or service headers.

These are implementation/admission policies, not a statement of every service quota:

- One materialized message is at most 1 MiB; complete data bytes per publish/pull batch are at most 4 MiB.
- `maxMessages` defaults to 100 and cannot exceed 1000; it also bounds explicit acknowledgement lists. Pull requires its
  own positive `maxMessages` no greater than that client bound. Duplicate acknowledgement tokens are refused.
- Each message has at most 100 attributes, each key at most 256 UTF-8 bytes and each value at most 1024 UTF-8 bytes.
  Malformed UTF-16 is refused before encoding. Prototype-sensitive attribute keys are outside this selected profile.
- Encoded request JSON is bounded at 8 MiB, including attribute escaping and base64 overhead, before retaining the
  aggregate batch. Response control bytes are independently bounded at 8 MiB before parsing. Declared lengths must match
  actual bytes; encoded control responses and malformed UTF-8 are refused.
- Control JSON is limited to depth 32, 100,000 tokens and 2 MiB lexical string tokens. Duplicate/prototype keys and
  fractional, exponent or unsafe numeric lexemes are refused before binary64 conversion. IDs/timestamps remain strings.
- Native output data uses canonical standard padded base64 in this finite profile. Incoming ordering keys are at most
  1024 UTF-8 bytes; message IDs are at most 1024 visible ASCII bytes and ack IDs at most 8192. More than 16 consecutive
  empty response chunks are refused.

There is no topic/subscription lifecycle API, schema negotiation, filtering configuration, streaming pull, seek/replay,
retention policy, dead-letter administration, exactly-once or publisher-authenticity claim. Provision those native
resources separately rather than inferring them from byte-message support.

## Primary contract and proof

The wire profile follows the Apache-2.0 Google APIs protobuf at immutable commit
[`a6151f3a9dc16e6bcce137fea69e13107f34bc6f`](https://github.com/googleapis/googleapis/blob/a6151f3a9dc16e6bcce137fea69e13107f34bc6f/google/pubsub/v1/pubsub.proto),
including native HTTP annotations and message/delivery fields. The official
[publish](https://docs.cloud.google.com/pubsub/docs/reference/rest/v1/projects.topics/publish),
[pull](https://docs.cloud.google.com/pubsub/docs/reference/rest/v1/projects.subscriptions/pull) and
[acknowledge](https://docs.cloud.google.com/pubsub/docs/reference/rest/v1/projects.subscriptions/acknowledge) references
explain those operations. No production SDK or new runtime dependency is introduced.

Sixteen authored protocol cases passed separately on Deno, Node and Bun. They cover exact bytes/nanoseconds, empty
pulls, caller snapshots, native data-or-attributes, escaped batch bounds, receipt identity, mutation uncertainty,
malformed numeric/duplicate JSON, cleanup, fatal UTF-8, redirects and credential admission. Normalized delivery-schema
validation and stalled-body deadline cleanup are also covered. The independent native test also passed with official
Cloud CLI 592.0.0, Pub/Sub emulator 0.8.37 and the official `@google-cloud/pubsub` 6.3.2 SDK. Every byte of a 128 KiB
message was checked in both directions, with original message IDs, zero-deadline redelivery, explicit acknowledgement
and known missing-resource refusals. The SDK runs only in its own copied-file container from 83 exact locked registry
package versions/integrities, using `npm ci --ignore-scripts` and no ambient ADC. The formerly separate SDK repository
moved to `google-cloud-node/handwritten/pubsub`; provenance pins its actual immutable source and lock rather than
relying on the archived location. The SDK implementation is not redistributed. A separate extract-only producer,
`tests/fixtures/pubsub/notices.ts`, preserves 84 original notice files from 81 of the 83 installed packages, with
package-qualified paths, exact byte hashes and inert base64 in `sdk-notices.json`. The installed
`@google-cloud/pubsub-api` and `data-uri-to-buffer` packages contained no matching notice file; their manifest license
metadata is retained separately and does not stand in for an absent notice. The producer checks every package path and
metadata file with `lstat`, follows no links, and imports no SDK code.

Actual Docker readback verified a 1 GiB RAM/swap-ceiling emulator with one CPU and a 512 MiB RAM/swap-ceiling oracle
with half a CPU, each with PID limit 128 and no host mounts. The private fake project, network and ephemeral port are
fixture-owned; all resources closed before successful return. A separate native raw capture records a 274-byte pull and
all six SDK-produced original bytes in `tests/fixtures/pubsub/independent.json`. Both acknowledgement and deadline
responses were HTTP 200 with four exact bytes, `{\n}\n`, matching the strict empty-object profile without parser
relaxation. Raw headers/byte hashes and license/version/resource receipts remain in provenance.

This is upstream emulator compatibility, not deployed Google service qualification. The official
[emulator limits](https://docs.cloud.google.com/pubsub/docs/emulator#known_limitations) exclude IAM, configurable
message retention and subscription expiration. The proof does not establish production retention, authentication,
billing, ordered concurrent processing or exactly-once behavior.

The bounded Node fixture benchmark replays that captured 274-byte pull and checks all six original bytes before timing.
The raw Fetch/JSON/base64 lower bound measured 12.665 µs mean (7.791 µs median); the validated warm-client pull measured
76.540 µs mean (47.875 µs median). These lanes measure in-memory parsing, admission and ownership costs, not deployed
Pub/Sub latency or equivalent conformance work. The isolated runner had one CPU, a 1 GiB RAM/swap ceiling, no network or
mounts and exited 0 without OOM. Provenance records the exact image, inputs and losslessly compressed timing output.
