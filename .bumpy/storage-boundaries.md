---
"@okikio/opfs": patch
---

### Reject hostile storage metadata before recursive work or allocation

Recursive listing, walk, copy, remove and empty-directory operations require one valid direct-child name from every
adapter. Record stores require consistent canonical path, parent and name fields. File records reject malformed or
noncanonical base64 and advertised sizes that differ from the decoded length. Deno KV manifests are checked against
configured part/count/size policy before acquiring pins or allocating part arrays. Existing malformed durable entries
need application repair; these checks deliberately do not reinterpret their identity.

Object adapter mapping options now also accept `maxListEntries`, with a default of 1,000,000 raw objects and prefixes
per scan. Duplicate entries count. This budget is separate from the existing 10,000-page default, and inspection reports
both in `adapter.limits`. Raise a budget explicitly for a legitimate larger namespace. Exhaustion rejects with
`too-large`; it cannot certify absence or an empty directory.

Windows host drivers refuse alternate data stream names and Win32 trimming/device aliases before I/O. Portable record,
object and browser names retain their existing grammar. Host roots still require trusted permissions and symlink policy.

### Keep a move's source stable through its fallback phases

An emulated move holds the facade's tree lock through copy and source removal. A participating writer queued during copy
now runs after the source has been removed, so its new data survives. This coordination does not make the two backend
commits crash-atomic or serialize independent backend writers. Materialized copy also rejects observed bytes above
`maxBufferedWriteBytes` even when the adapter advertises a smaller size.

### Retain request deadlines through the acquired response body

S3/Azure request deadlines and caller cancellation now remain active after headers. EOF, source errors and consumer
cancellation retire the timer and reader. An unread body is actively cancelled when its caller aborts. An
acknowledgement returned by an injected Fetch after an already observed abort remains readable for publication
reconciliation.

Control XML and error bodies have an 8 MiB observed-byte ceiling. XML is also limited to 64 nesting levels, 128
attributes per element and 100,000 nodes, and tree traversal no longer recurses. These safety limits do not apply to
file payloads. Oversized acknowledgements fail rather than certifying publication; applications should reconcile
uncertain operations.
