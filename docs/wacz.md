# Read and write WACZ files

A WACZ file is a ZIP that packages web archive captures for replay. It holds WARC files, a CDXJ index that says where
each capture is, a page list, and a manifest with every file's size and SHA-256. Replay tools such as ReplayWeb.page
read it over HTTP range requests, without downloading the whole file.

```text
example.wacz (ZIP)
├── archive/data.warc.gz       WARC records, STORED so a record is one byte range
├── indexes/index.cdxj         one line per record: URL, time → file, offset, length
├── pages/pages.jsonl          pages to list first
├── datapackage.json           every file's path, size and sha256
└── datapackage-digest.json    sha256 of datapackage.json
```

`archive/wacz` reads WACZ files. `archive/wacz/write` writes them. Both follow
[WACZ 1.1.1](https://specs.webrecorder.net/wacz/1.1.1/).

## Find and read one capture

```ts
import { createBlobSource } from "@okikio/opfs/source";
import { openWacz } from "@okikio/opfs/archive/wacz";

const wacz = await openWacz(createBlobSource(file), { maxSourceBytes: 1024 * 1024 * 1024 });
const hit = (await wacz.readIndex()).find((record) => record.url === "https://example.com/");
if (hit) {
  const warc = await wacz.openWarc(hit.filename);
  const entry = warc.entries.find((entry) => entry.offset === hit.offset)!;
  const response = await warc.read(entry.id); // the HTTP status line, headers and body
}
```

`openWacz()` reads the ZIP directory and `datapackage.json`. Everything else is read when you ask:

| Call                 | Reads                                                                     |
| -------------------- | ------------------------------------------------------------------------- |
| `wacz.package`       | already parsed `datapackage.json`; unknown fields are kept                |
| `wacz.warcs`         | file names under `archive/`                                               |
| `readPages(name?)`   | `pages/pages.jsonl`, or another `pages/` file; the header line is skipped |
| `readIndex()`        | every `.cdx`, `.cdxj`, `.cdx.gz` and `.cdxj.gz` under `indexes/`          |
| `openWarc(filename)` | `archive/<filename>` as a WARC; see [WARC](warc.md)                       |
| `verify()`           | every listed file once, to check sizes and hashes                         |
| `wacz.zip`           | the ZIP reader, for files this API does not model                         |

`openWarc()` works because WACZ requires WARC files to be STORED in the ZIP: the WARC bytes are one range of the WACZ,
so a record's range is too. A compressed or encrypted WARC member fails with `unsupported-profile`.

Gzip indexes can be several concatenated gzip members, as ZipNum `.cdx.gz` files are. `readIndex()` decodes them all and
parses the lines. ZipNum `.idx` secondary indexes are skipped; the records come from the `.cdx.gz` file itself.

All reads go through the ZIP reader that `openWacz()` created, so its limits and `signal` cover the WACZ's whole life.
The defaults (64 MiB source bytes, 4,096 requests) suit small files. Raise `maxSourceBytes`, `maxDecodedBytes` and
`maxRequests` for large collections. `maxTextBytes` (default 16 MiB) caps each manifest, page or index file read as
text.

## Verify a WACZ

```ts
const report = await wacz.verify();
// { valid: true, errors: [], missing: [], checked: 4 }
```

`verify()` checks that:

- `datapackage-digest.json`, when present, names `datapackage.json` and matches its SHA-256;
- each listed resource exists, has the listed size and the listed `sha256:` hash;
- each file in the ZIP is listed, apart from the two manifests;
- every `archive/` file is STORED;
- `archive/`, `indexes/` and `pages/pages.jsonl` exist; absent ones are in `missing`;
- every CDXJ line points at a real capture (see below); `records` counts the lines that passed.

Hashes prove the files did not change. They do not prove a replay tool will find anything, so `verify()` also follows
every CDXJ line into its WARC:

| Check                    | Fails when                                                                            |
| ------------------------ | ------------------------------------------------------------------------------------- |
| The WARC exists, STORED  | the line names a file not under `archive/`, or one the ZIP compressed                 |
| The range fits           | `offset + length` passes the end of the file, or two lines share the same coordinates |
| A record starts there    | no WARC record starts at `offset`, or the record there uses a different `length`      |
| It can be replayed       | the record is not a `response`, `resource` or `revisit`                               |
| It is the right capture  | `WARC-Target-URI` is not the line's `url`                                             |
| The line agrees          | `status` or `mime` differs from the HTTP head, or `digest` from `WARC-Payload-Digest` |
| Every page has a capture | a page in `pages/pages.jsonl` has no replayable line for its `url`                    |

Each WARC is indexed once, and only the first 64 KiB of a response block is read to find its status and media type.

Hashing uses a streaming SHA-256, so a large WARC is read in 1 MiB parts and never held whole. A match detects
corruption. It does not prove who made the file: signed `datapackage-digest.json` files are read, but their signatures
are not checked.

## Write a WACZ

`createWaczStream()` takes WARC files, an index and pages, and returns the ZIP as a stream. Use `createWarcStream()`'s
`onRecord` to collect the index while you write the WARC:

```ts
import { createWarcStream } from "@okikio/opfs/archive/warc/write";
import { createWaczStream } from "@okikio/opfs/archive/wacz/write";
import type { CdxjInputType } from "@okikio/opfs/archive/wacz";

const index: CdxjInputType[] = [];
const warc = new Uint8Array(
  await new Response(createWarcStream(records, {
    compression: "gzip",
    onRecord: (r) =>
      r.targetUri &&
      index.push({ url: r.targetUri, date: r.date, offset: r.offset, length: r.length, filename: "data.warc.gz" }),
  })).arrayBuffer(),
);

await fs.writeFile(
  "/example.wacz",
  createWaczStream({
    warcs: [{ name: "data.warc.gz", source: warc }],
    index,
    pages: [{ url: "https://example.com/", ts: "2026-11-24T10:00:00Z", title: "Example" }],
    title: "Example",
    mainPageUrl: "https://example.com/",
  }),
);
```

The writer computes each file's SHA-256 while the ZIP writer reads it, and writes `datapackage.json` and
`datapackage-digest.json` last. A WARC source can be a stream; it is read once and not held in memory. Extra `files` are
allowed and listed, but not under `archive/`, `indexes/` or `pages/`, which the spec reserves.

Each kind of file gets the ZIP method that suits it:

| Files                                     | ZIP method | Why                                                                       |
| ----------------------------------------- | ---------- | ------------------------------------------------------------------------- |
| `archive/*.warc.gz`, `archive/*.warc`     | STORED     | a CDXJ offset must be a byte range of the WACZ; `.warc.gz` is gzip anyway |
| `indexes/`, `pages/`, `datapackage*.json` | DEFLATED   | JSON and CDXJ text usually shrinks to a small fraction                    |
| extra `files`                             | DEFLATED   | unless the file sets `compression: "store"` (an image, a `.gz`)           |

Asking for a compressed WARC throws, because it would break every CDXJ offset into it.

ZIP64 is on. The defaults still cap the file at 64 MiB per file and 1 GiB in total, and a WACZ under 4 GiB is plain
ZIP32. Raise `maxEntryBytes` and `maxArchiveBytes` for larger WARCs, past 4 GiB if you need, and the writer adds ZIP64
fields only where a size or offset needs them. Pass `zip64: false` to refuse. Write to a temporary name and rename after
the stream ends.

## Stream a crawl into a WACZ

A long crawl should not build one huge WARC in memory. `createWarcSegments()` writes records across numbered WARC files,
starting a new one between records once a file reaches `maxSegmentBytes`. Each segment starts with a `warcinfo` record
and is a complete WARC. Segments have `name` and `source`, so they go straight into `createWaczStream()`, and `onRecord`
reports each record's file and range, so the index fills while the WARCs stream:

```ts
import { createResponseRecord, createWarcSegments } from "@okikio/opfs/archive/warc/write";
import { createWaczStream } from "@okikio/opfs/archive/wacz/write";
import type { CdxjInputType } from "@okikio/opfs/archive/wacz";

const index: CdxjInputType[] = [];
const warcs = createWarcSegments(
  captures.map((capture) => createResponseRecord(capture)), // { url, status, headers, body }
  {
    maxSegmentBytes: 1024 ** 3,
    onRecord: (r) =>
      r.targetUri && index.push({
        url: r.targetUri,
        date: r.date,
        filename: r.filename, // segment-000001.warc.gz, segment-000002.warc.gz, ...
        offset: r.offset,
        length: r.length,
        ...(r.status === undefined ? {} : { status: r.status }),
        ...(r.mime === undefined ? {} : { mime: r.mime }),
        ...(r.payloadDigest === undefined ? {} : { digest: r.payloadDigest }),
      }),
  },
);
await fs.writeFile(
  "/crawl.wacz",
  createWaczStream({ warcs, index, pages }, { maxEntryBytes: 2 * 1024 ** 3, maxArchiveBytes: 64 * 1024 ** 3 }),
);
```

The ZIP writer reads one segment to its end before it asks for the next, which is what `createWarcSegments()` needs:
asking for a segment before the last one was read throws. `index` is complete by the time the writer reaches
`indexes/index.cdxj`, because the index is written after every WARC.

## CDXJ lines

`createCdxj(records)` formats and sorts index lines. `parseCdxj(text)` reads them back. `getSurt(url)` returns the sort
key.

```text
com,example)/ 20261124100000 {"url":"https://example.com/","status":200,"offset":0,"length":187,"filename":"data.warc.gz"}
```

The key drops the scheme and a leading `www.`, reverses the host labels, sorts query parameters and lowercases the
result, as pywb's default does. It only orders lines; replay tools match on `url`. `parseCdxj()` accepts pywb's string
numbers such as `"offset": "512"`.

## Limits

- No WACZ signing, and signatures are not verified.
- Interoperability is tested against this package's own reader, Python's `zipfile`, `zlib` and `hashlib`, and Info-ZIP
  `unzip`, not against ReplayWeb.page or py-wacz output files.
- `readIndex()` returns every line; it does not binary-search ZipNum blocks.
