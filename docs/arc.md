# Preview Internet Archive ARC records

`openArc()` indexes a single uncompressed Internet Archive ARC 1.0 file. It lists physical captures and reads selected
stored byte ranges without retrieving every complete block. This is the web-capture format that preceded WARC, separate
from the SEA ARC compression format.

An ARC block contains the bytes captured from a protocol. For HTTP, those bytes include the HTTP response headers.
Selecting a range does not remove those headers, decode chunking, decompress an HTTP entity, render HTML or retrieve a
URL. A capture's ordinal `id` identifies it within this file; repeated URLs and dates remain separate captures.

```ts
import { openArc } from "@okikio/opfs/archive/arc";
import { createBlobSource } from "@okikio/opfs/source";

export async function previewArc(bytes: ArrayBuffer) {
  const archive = await openArc(createBlobSource(new Blob([bytes])));
  const capture = archive.entries.find((entry) => entry.kind === "record");
  if (!capture) return { archive, capture: undefined, preview: undefined };
  const preview = await archive.read(capture.id, { length: Math.min(capture.size, 64) });
  const storedBlock = archive.source(capture.id);
  return { archive, capture, preview, storedBlock };
}
```

The returned `preview.bytes` are unrendered bytes with `integrity: "none"`. Framing alone supplies no checksum,
authenticity or capture-completeness evidence. The `storedBlock` is a `ByteSourceType` that supports exact selected
ranges. It can be supplied to another reader only when that reader expects the complete stored protocol block. For
example, passing a stored HTTP response directly to a ZIP reader does not make the HTTP headers disappear.

## Choose descriptor framing explicitly

ARC begins with a special `filedesc://...` record that describes the file. The initial supported version line is
`1 0 <producer text>` followed by the canonical five-field definition. This reader calls the second field `reserved`; it
does not treat every possible value as a supported format minor version. In particular, the Heritrix `1 1` metadata
extension and version 2 field layouts are unsupported profiles.

Two genuine tools count the file-description separator differently:

| Option                                          | Descriptor block                                                        | Separator                                     | Independent evidence                                                                                        |
| ----------------------------------------------- | ----------------------------------------------------------------------- | --------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `filedescSeparator: "outside-length"` (default) | Two LF-terminated descriptor lines                                      | One additional LF outside the declared length | Native JWAT 1.2.1 output passes its strict reader and warcio 1.7.5                                          |
| `filedescSeparator: "inside-length"`            | The same two lines plus exactly one blank LF within the declared length | No additional descriptor separator            | Native IIPC ARCWriter 3.0.5 output; JWAT accepts it in lax mode, while its strict mode and warcio reject it |

Set the second option only when the capture's producer uses that explicit profile:

```ts
import { openArc } from "@okikio/opfs/archive/arc";
import type { ByteSourceType } from "@okikio/opfs/source";

export async function inspectIipc(source: ByteSourceType) {
  const archive = await openArc(source, { filedescSeparator: "inside-length" });
  return { separator: archive.filedesc.separator, descriptor: await archive.read(0) };
}
```

The option changes physical descriptor framing only. Its returned descriptor range still contains **all declared
bytes**, including the counted blank LF. No bytes or lengths are trimmed, repaired or guessed. Ordinary records always
require one separator LF outside their declared block length, even when the block itself ends with LF. Concatenated
logical ARC files are explicitly unsupported instead of allowing a later `filedesc://` to silently reset the profile.

The original Internet Archive reference defines a Unix LF delimiter but has ambiguities in its displayed version-block
spacing. The implementation therefore names its exact admission rule and exposes the observed compatibility choice. The
tests retain both complete producer outputs and the failed independent-consumer diagnostics. A tolerant consumer's
acceptance is not used to claim that every producer's framing is interchangeable.

## Inspect metadata and read exact ranges

`archive.format` is `"internet-archive-arc"` and `version` is `"1.0"`. The frozen `entries` array includes descriptor 0
and all subsequent physical records. Each entry contains `id`, `kind`, literal `url`, `ip`, `date`, `contentType`,
`headerOffset`, `blockOffset` and stored `size`. `filedesc` contains preserved producer `origin`, `reserved: "0"` and
the selected separator policy. The declaration's filename and URLs are untrusted metadata, never host paths or fetch
instructions. There is no URI normalization, percent decoding or filesystem access.

`read(id, { offset, length })` buffers exactly the selected stored range. The defaults select the whole block. Unsafe,
negative, fractional or out-of-block ranges fail; empty ranges perform no source I/O. `source(id, options)` can expose
the same selected extent as a byte source. Its read options use offsets relative to that extent. A derived identity
encodes the original identity, format, physical offset and extent length as an unambiguous JSON tuple. This identifies
the physical view; it is not a cryptographic digest.

Opening captures the original source's size, bound read method, identity and stability. An identity must be a string of
at most 8192 UTF16 code units. `immutable`, `provider` or `caller` stability evidence is required unless
`allowUnverifiedSource: true` explicitly accepts an unverified source. The returned `provenance` states that evidence.
The source, resources and cancellation authority remain borrowed: the application keeps the snapshot available and owns
its cleanup. A caller assertion is only as reliable as the caller's snapshot discipline.

Record metadata uses printable ASCII, exactly five nonempty fields separated by one ASCII space and terminated by LF.
CRLF metadata, non-ASCII URL spellings, tabs and repeated spaces are outside this profile. Network blocks remain
arbitrary binary, including NUL, CRLF, fake headers and delimiter-like bytes. Content type remains the declared token;
the reader does not inspect its agreement with the stored bytes or claim complete MIME semantic validation.

Dates require 14 digits in `YYYYMMDDhhmmss` UTC form, with a valid calendar date. Leap seconds are explicitly
unsupported. The initial address profile accepts dotted-quad IPv4 octets 0..255; the descriptor also accepts the legacy
`0` token shown in the original reference. IPv6 metadata is pending. The descriptor origin preserves printable producer
text, including spaces because the primary reference's own example uses `Alexa Internet` despite its prose describing a
single token. These are explicit reader profiles, not a claim that every refused capture violates every historic ARC
implementation.

## Bound opening and selected reads

Opening reads bounded metadata lookahead, jumps across stored block extents using checked byte lengths and checks
separators. A lookahead chunk can include a block prefix; those fetched bytes count as source work. It does not promise
zero payload I/O while indexing. Large blocks are otherwise skipped without decoding or scanning their contents.

| Policy             | Default     | Implementation ceiling or accounting                      |
| ------------------ | ----------- | --------------------------------------------------------- |
| `maxEntries`       | 10000       | Includes the descriptor                                   |
| `maxLineBytes`     | 8192 bytes  | Excludes LF; hard 65536                                   |
| `maxFiledescBytes` | 65536 bytes | Hard 1 MiB                                                |
| `maxMetadataBytes` | 4 MiB       | Retained header/descriptor bytes plus 128 bytes per entry |
| `maxChunkBytes`    | 4096 bytes  | Admitted 1..65536                                         |

The metadata allowance is an estimate, not a precise JavaScript heap bound. General archive
source/request/decoded/output limits default to64 MiB/4096/64 MiB/16MiB. Opening metadata and selected bytes count as
decoded work; only selected returned bytes count as output. Selected range allocation admits its complete
source/request/decoded/output allowance before acquisition. `work` records opening work, while each `read()` result
reports its own work. A source wrapper enforces cumulative limits across its reads. All operations additionally use the
opening ledger; an explicitly supplied `createArchiveLedger()` can coordinate this view with other readers. Native
source implementations can perform extra transport work that this archive-level accounting cannot observe.

A per-operation `signal` overrides the opening signal. A selected source composes its captured signal with each read's
signal, and the reader checks cancellation after source acquisition. It never acquires resources that would transfer a
cleanup obligation. Native source failures retain their original error. Malformed framing uses `invalid-archive`, a
refused profile uses `unsupported-profile`, and an exhausted policy uses `budget-exceeded`.

Gzip and record-compressed gzip are separate work. A gzip source is refused explicitly. Existing compression APIs can
perform sequential decoding where their profile supports it; opening this index still requires an explicitly supplied,
known-size addressable source of the uncompressed bytes. There is no implicit whole-archive decompression, gzip seek
index, reconstruction of missing captures, ARC2WARC conversion, HTTP replay or logical entity extraction.

## Independent evidence

The primary format reference is Internet Archive's
[ARC File Format Reference, version 1.0,15 September1996](https://archive.org/web/researcher/ArcFileFormat.php).
Producer source and artifact byte hashes are recorded in
[fixture provenance](https://github.com/okikio/opfs/blob/49834d7/tests/fixtures/arc/README.md). The retained corpus uses
native [JWAT 1.2.1](https://repo.maven.apache.org/maven2/org/jwat/jwat-arc/1.2.1/) and
[IIPC webarchive-commons 3.0.5](https://repo.maven.apache.org/maven2/org/netpreserve/commons/webarchive-commons/3.0.5/).
Both write authored offline blocks, including complete HTTP responses, binary data containing a fake record line,
duplicate capture URLs and an empty block. Native consumers and warcio compare complete stored bytes against those
authored oracles. Warcio's inability to read the unchanged IIPC filedesc is retained rather than hidden by modifying its
input. Test-only Java/Python tools are absent from production imports and manifests. This evidence covers the stated
producer profiles, not all historic ARC archives or deployed storage.
