---
npm/@okikio/opfs: minor
---

Stream a whole crawl into a WACZ, and check that its index points at real captures.

**DEFLATE and ZIP64 in the ZIP writer.** A `createZipStream()` entry can set `compression: "deflate"`, and `zip64: true`
lets entries and archives pass 4 GiB and 65,534 entries. ZIP64 fields appear only where a value needs them, so a small
archive is the same bytes as before.

```ts
import { createZipStream } from "@okikio/opfs/archive/zip/write";

createZipStream([
  { name: "data.json", source: json, compression: "deflate" },
  { name: "photo.jpg", source: jpeg }, // STORED, the default
], { zip64: true, maxEntryBytes: 8 * 1024 ** 3, maxArchiveBytes: 64 * 1024 ** 3 });
```

**WACZ compression by file type.** `createWaczStream()` keeps WARC files STORED, so CDXJ offsets stay byte ranges, and
now DEFLATES the index, the page list, both manifests and extra files (an extra file can ask for `"store"`). It turns
ZIP64 on, and `warcs` may be an async iterable.

| Before                  | After                                  |
| ----------------------- | -------------------------------------- |
| every file STORED       | WARCs STORED; JSON and CDXJ DEFLATED   |
| ZIP32 only, under 4 GiB | ZIP64 when the caps you set pass 4 GiB |

**HTTP records and payload digests.** `createResponseRecord()` and `createRequestRecord()` build `application/http`
records. For those blocks the WARC writer adds `WARC-Payload-Digest` and reports `status`, `mime` and `payloadDigest` to
`onRecord`, which are the CDXJ `status`, `mime` and `digest` fields.

**WARC segments.** `createWarcSegments(records, { maxSegmentBytes })` writes `segment-000001.warc.gz` and up, starting a
new file only between records. Each segment opens with a `warcinfo` record and goes straight into `createWaczStream()`.
See `docs/wacz.md` for the crawl-to-WACZ example.

**Replay checks in `verify()`.** `openWacz(...).verify()` now follows every CDXJ line into its WARC: the file is STORED,
the range fits, a record starts there with that length, it is a `response`, `resource` or `revisit` for that URL, and
its status, media type and payload digest agree. Every page needs a replayable line. The report gains `records`, the
number of lines that passed. A WACZ that passed before can now fail, when its index was wrong.

Checked against Python's `zipfile`, `zlib`, `hashlib` and Base32, and Info-ZIP `unzip`: a 30-record, 6-segment WACZ with
every CDXJ range, Target-URI, status, block digest and payload digest confirmed independently.
