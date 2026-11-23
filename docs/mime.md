# Preview mail bodies and attachments

`openMime()` lists the physical body parts of a strict CRLF EML message. You can preview one attachment or body without
rendering HTML, resolving embedded URLs or interpreting a filename as a path. Multipart indexing must scan the message
body to find its boundaries; a remote multipart message therefore costs a bounded full wire scan before the first
preview.

```ts
import { createBlobSource } from "@okikio/opfs/source";
import { openMime } from "@okikio/opfs/archive/mime";

async function previewAttachment(eml: Blob): Promise<Uint8Array | undefined> {
  const mail = await openMime(createBlobSource(eml));
  const attachment = mail.entries.find((part) => part.filenameStatus === "decoded");
  if (!attachment) return undefined;
  const result = await mail.prefix(attachment.id, 1024);
  console.log(attachment.filename, result.complete, result.work);
  return result.bytes;
}
```

The application supplies the `Blob`, or another stable `ByteSourceType`. Source ownership remains with the application.
The reader captures the source's admitted size and read capability, requires declared stability or explicit
`allowUnverifiedSource: true`, and never closes the source. That declaration still depends on the source provider or
caller keeping its bytes stable; an identity string alone provides no such proof.

Entries use ordinals including the root message at ID 0, and `parent` ordinals describe the MIME tree. Filenames,
content IDs, subjects and addresses never replace those ordinals. `fields` preserves ordered names and unfolded values,
including unknown or repeated uninterpreted fields. `readHeaders(id)` returns original header bytes, including the
terminating blank line. `offset`/`size` describe encoded body bytes and exclude the CRLF owned by a multipart delimiter.
A multipart entry's raw body includes its own nested boundaries. It is not a decoded attachment.

## Choose complete decoding or a prefix

`read(id)` decodes a selected leaf's complete transfer encoding and validates its end before returning. Providing
`offset` and `length` selects an exact **decoded** range but still drains and validates the entire encoding. An invalid
suffix therefore fails a complete read even when the selected prefix was valid. A decoded range beyond EOF fails with
`RangeError`; a zero-length complete read still examines the encoding and checks the offset.

`prefix(id, maximum, { offset })` returns up to `maximum` decoded bytes, discarding earlier decoded bytes if necessary.
It stops when enough bytes are available. `complete: false` means an encoded suffix may remain unexamined. Exact-limit
results can conservatively report false even when their source happened to end there. A zero-byte prefix performs no
payload read and always reports false, including for empty parts or an offset whose validity is still unknown. A nonzero
prefix offset beyond decoded EOF fails with `RangeError`.

```ts
const whole = await mail.read(part.id); // complete:true; whole transfer encoding examined
const range = await mail.read(part.id, { offset: 100, length: 20 }); // also validates the entire encoding
const prefix = await mail.prefix(part.id, 20); // complete can be false
const wire = await mail.readRaw(part.id, { offset: 0, length: 20 }); // encoded wire bytes, no transfer validation
```

Here `mail` is an opened archive and `part` is one of its leaf entries whose decoded and wire lengths admit the shown
ranges. A leaf `message/rfc822` stays opaque message bytes; this profile does not recursively parse embedded messages.
`readRaw()` provides exact addressable wire ranges even for multipart containers or unknown encodings. Raw/header reads
report `complete: false`, because they do not examine the leaf's transfer encoding. All results report
`integrity: "none"`. Completing transfer decoding does not verify a signature, authenticate a sender or make the content
safe to render.

Base64 and quoted-printable decoding advance from the part's beginning. They do not provide constant-cost decoded
seeking. Source reads include bounded lookahead; decoding can produce a few bytes beyond a requested prefix quantum.
Discarded and examined decoded bytes count against `maxDecodedBytes`; returned bytes alone count against
`maxOutputBytes`. Opening counts acquired wire chunks as decoded inspection work, including lookahead and multipart
preamble/epilogue. Share a `ledger` across open/read/prefix calls to enforce aggregate budgets. Returned results are
buffered: a public streaming part API is pending. Temporary memory includes small decoder buffers, retained output
chunks and their final combined copy. Peak returned-output storage can approach twice the admitted output byte count.

## Strict parsing and display metadata

The header profile requires a terminating blank CRLF line, ASCII field names and ASCII values by default.
`utf8Headers: true` admits strictly decoded UTF-8 values using RFC 6532. Unfolding removes CRLF and preserves following
space/tab, as required by RFC 5322. The default physical header line ceiling is 998 bytes. Header-only messages without
a blank line, bare-LF mail, obsolete syntax, comments or whitespace around the media-type slash, and nonliteral
MIME-Version 1.0 are unsupported by this profile. Dates, address lists and RFC 2047 encoded words remain uninterpreted
raw strings; this reader is not a complete RFC 5322 semantic or liberal-repair implementation. Header and parameter
checks do not validate required sender/date/MIME-Version rules, per-subtype required fields or cryptographic object
structure.

Ambiguous duplicate Content-Type, Content-Transfer-Encoding, Content-Disposition, MIME-Version and parameter names fail.
Other duplicate fields remain visible. Media types and parameter names are case-insensitive. Quoted parameters support
escaped characters. Filename display supports plain ASCII and a single RFC 2231 UTF-8 or US-ASCII extended parameter.
Extended continuations, conflicting filename forms, unsupported charsets, malformed percent encoding and RFC 2047 words
in parameters produce `filenameStatus: "unsupported"`; their original fields remain available. A decoded name can
contain separators or control characters encoded by its producer: applications must escape it for display and apply
their own destination policy before creating a file. No automatic extraction occurs.

Identity transfer encodings are 7bit, 8bit and binary; 7bit rejects encountered high bytes. This is not a complete SMTP
transport-line validator. Base64 accepts its alphabet, canonical padding/unused bits and ASCII space/tab/CR/LF only. RFC
2045 describes liberal ignored-junk handling; this implementation deliberately uses a narrower strict admission profile.
Quoted-printable requires uppercase hex escapes, accepts `=CRLF` soft breaks, preserves hard CRLF and discards literal
trailing space/tab transport padding. Its encoded line ceiling is 76 characters excluding CRLF. Unknown transfer
encodings remain listable/raw-readable but decoded reads fail.

Multipart boundaries must be 1..70 ASCII characters under the RFC 2046 boundary grammar, cannot end in a space, and have
separately bounded transport padding. The scanner checks all active ancestors. Missing closing delimiters, premature
outer delimiters and empty multiparts fail. Prefix-colliding ancestor boundary names and encoded multipart containers
are refused. Unknown multipart subtypes use the same structural framing; this does not add subtype-specific behavior.
Children of multipart/digest default to message/rfc822; other absent types default to text/plain with US-ASCII charset.

`protection` is an **untrusted declaration** from MIME headers. Signed multipart/signature types and S/MIME signed-data
are marked `signed-unverified`; encrypted multipart or declared S/MIME enveloped data are `encrypted-opaque`. Other
PKCS7 MIME content is `opaque-security`. These labels do not inspect the cryptographic object. They install no verifier,
keys, renderer, decryption or network resolver. HTML and ciphertext remain inert returned bytes.

## Limits, cancellation and evidence

Defaults are 1000 parts including the root, 16 nesting levels, 64 KiB per header, 128 fields per part, 4 MiB cumulative
header metadata, 256 boundary-padding bytes, and 4096-byte source chunks. `maxChunkBytes` can be 1..65536. General
archive defaults are 64 MiB source bytes, 4096 requests, 64 MiB decoded work and 16 MiB returned bytes per operation.
These independent finite policies can stop indexing or decoding before other ceilings. A source implementation can
allocate before returning; native byte extent validation rejects an oversized/short result but cannot govern that
implementation's hidden work.

Signals propagate to each source read and are checked before returning. Cancellation and source errors do not close the
borrowed source, retry reads or return a partial result. Format errors use `invalid-archive`, unsupported profiles use
`unsupported-profile`, and finite policy exhaustion uses `budget-exceeded`. A full encoding failure returns no preview;
the caller can separately request an explicit prefix when partial examination is appropriate.

Saved fixtures come from CPython's independent email producer and parser, with fixed boundaries, authored payloads and
SHA-256 provenance in `tests/fixtures/mime/README.md`. Chunk-ceiling cases 1..80 exercise nested boundaries across
source reads. This evidence covers these supported profiles and authored refusals, not universal mail conformance. MBOX
remains a separate pending framing format; this API does not split or unescape mailbox files.

Primary references are [RFC 5322](https://www.rfc-editor.org/rfc/rfc5322),
[RFC 2045](https://www.rfc-editor.org/rfc/rfc2045), [RFC 2046](https://www.rfc-editor.org/rfc/rfc2046),
[RFC 2231](https://www.rfc-editor.org/rfc/rfc2231), [RFC 6532](https://www.rfc-editor.org/rfc/rfc6532) and
[S/MIME RFC 8551](https://www.rfc-editor.org/rfc/rfc8551).
