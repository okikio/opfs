import { describe, it } from "node:test";
import { expect } from "@std/expect";
import { createByteSource } from "../src/source.ts";
import { createZipStream } from "../src/archive/zip/write.ts";
import { createWarcStream, type WarcWriteRecordType } from "../src/archive/warc/write.ts";
import { type CdxjInputType, createCdxj, getSurt, openWacz, parseCdxj } from "../src/archive/wacz/mod.ts";
import { createWaczStream } from "../src/archive/wacz/write.ts";

const encode = (text: string): Uint8Array => new TextEncoder().encode(text);
const text = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);
const collect = async (stream: ReadableStream<Uint8Array>): Promise<Uint8Array> =>
  new Uint8Array(await new Response(stream).arrayBuffer());

const records: WarcWriteRecordType[] = [
  {
    type: "response",
    targetUri: "https://example.com/",
    date: "2026-11-24T10:00:00Z",
    contentType: "application/http; msgtype=response",
    block: encode("HTTP/1.1 200 OK\r\nContent-Type: text/html\r\n\r\n<h1>Hi</h1>"),
  },
  {
    type: "response",
    targetUri: "https://example.com/style.css",
    date: "2026-11-24T10:00:01Z",
    contentType: "application/http; msgtype=response",
    block: encode("HTTP/1.1 200 OK\r\nContent-Type: text/css\r\n\r\nh1{}"),
  },
];

/** Writes a `.warc.gz` and the CDXJ inputs for its records. */
async function getWarc(): Promise<{ bytes: Uint8Array; index: CdxjInputType[] }> {
  const index: CdxjInputType[] = [];
  const bytes = await collect(createWarcStream(records, {
    compression: "gzip",
    onRecord: (record) =>
      index.push({
        url: record.targetUri!,
        date: record.date,
        offset: record.offset,
        length: record.length,
        filename: "data.warc.gz",
        status: 200,
      }),
  }));
  return { bytes, index };
}

describe("CDXJ", () => {
  it("builds SURT keys in the pywb form", () => {
    expect(getSurt("https://www.Example.com:443/A/b?z=1&a=2")).toBe("com,example)/a/b?a=2&z=1");
    expect(getSurt("http://example.com:8080")).toBe("com,example:8080)/");
    expect(getSurt("urn:x:y")).toBe("urn:x:y");
  });

  it("sorts lines and parses pywb string numbers", () => {
    const text = createCdxj([
      { url: "https://b.example/", date: new Date("2026-01-01T00:00:00Z"), filename: "a.warc", offset: 9, length: 3 },
      {
        url: "https://a.example/",
        date: "20250101000000",
        filename: "a.warc",
        offset: 0,
        length: 9,
        mime: "text/html",
      },
    ]);
    const lines = text.trim().split("\n");
    expect(lines[0]!.startsWith("example,a)/ 20250101000000 ")).toBe(true);
    const parsed = parseCdxj(
      text +
        'example,c)/ 20260101000000 {"url":"https://c.example/","offset":"5","length":"7","status":"404","filename":"b.warc"}\n',
    );
    expect(parsed.map((record) => [record.url, record.offset, record.length])).toEqual([
      ["https://a.example/", 0, 9],
      ["https://b.example/", 9, 3],
      ["https://c.example/", 5, 7],
    ]);
    expect(parsed[2]!.status).toBe(404);
    expect(parsed[0]!.mime).toBe("text/html");
  });

  it("refuses lines that cannot locate a record", () => {
    expect(() => parseCdxj('com,x)/ 2026 {"url":"https://x/"}')).toThrow();
    expect(() => parseCdxj("com,x)/ 2026 not-json")).toThrow();
  });
});

describe("WACZ", () => {
  it("writes a package that opens, verifies and replays one record by offset", async () => {
    const warc = await getWarc();
    const bytes = await collect(createWaczStream({
      // A stream source checks that hashing happens while the ZIP writer reads.
      warcs: [{ name: "data.warc.gz", source: new Blob([new Uint8Array(warc.bytes).buffer]).stream() }],
      index: warc.index,
      pages: [{ url: "https://example.com/", ts: "2026-11-24T10:00:00Z", title: "Example" }],
      title: "Example",
      mainPageUrl: "https://example.com/",
      created: new Date("2026-11-24T12:00:00Z"),
      files: [{ name: "logs/crawl.txt", source: encode("ok") }],
    }));
    const wacz = await openWacz(createByteSource(bytes));
    expect(wacz.package.wacz_version).toBe("1.1.1");
    expect(wacz.package.created).toBe("2026-11-24T12:00:00.000Z");
    expect(wacz.warcs).toEqual(["data.warc.gz"]);
    expect(wacz.package.resources.map((resource) => resource.path)).toEqual([
      "archive/data.warc.gz",
      "logs/crawl.txt",
      "indexes/index.cdxj",
      "pages/pages.jsonl",
    ]);
    const report = await wacz.verify();
    expect(report).toEqual({ valid: true, errors: [], missing: [], checked: 4 });
    expect(await wacz.readPages()).toEqual([{
      url: "https://example.com/",
      ts: "2026-11-24T10:00:00Z",
      title: "Example",
    }]);
    const index = await wacz.readIndex();
    const hit = index.find((record) => record.url === "https://example.com/style.css")!;
    const archive = await wacz.openWarc(hit.filename);
    const entry = archive.entries.find((entry) => entry.offset === hit.offset)!;
    expect(entry.length).toBe(hit.length);
    expect(text((await archive.read(entry.id)).bytes)).toContain("h1{}");
    // The STORED ZIP member is a byte range of the WACZ, so the WARC member is too.
    const zipEntry = wacz.zip.entries.find((entry) => entry.name === "archive/data.warc.gz")!;
    expect(zipEntry.method).toBe(0);
  });

  it("reports changed bytes, unlisted files and missing parts", async () => {
    const warc = encode("not really a warc");
    const manifest = {
      profile: "data-package",
      wacz_version: "1.1.1",
      resources: [{ path: "archive/a.warc", hash: `sha256:${"0".repeat(64)}`, bytes: warc.length }],
    };
    const bytes = await collect(createZipStream([
      { name: "archive/a.warc", source: warc },
      { name: "extra.txt", source: encode("x") },
      { name: "datapackage.json", source: encode(JSON.stringify(manifest)) },
      {
        name: "datapackage-digest.json",
        source: encode(JSON.stringify({ path: "datapackage.json", hash: "sha256:00" })),
      },
    ]));
    const report = await (await openWacz(createByteSource(bytes))).verify();
    expect(report.valid).toBe(false);
    expect(report.missing).toEqual(["indexes/", "pages/pages.jsonl"]);
    expect(report.errors).toEqual([
      "datapackage-digest.json does not match datapackage.json.",
      "archive/a.warc sha256 does not match datapackage.json.",
      "extra.txt is in the ZIP but not in datapackage.json.",
    ]);
  });

  it("reads a gzip index made of several members", async () => {
    const warc = await getWarc();
    const lines = createCdxj(warc.index).trim().split("\n");
    const gzip = async (line: string) =>
      await collect(new Blob([`${line}\n`]).stream().pipeThrough(new CompressionStream("gzip")));
    const members = await Promise.all(lines.map(gzip));
    const index = new Uint8Array(members.reduce((size, member) => size + member.length, 0));
    let offset = 0;
    for (const member of members) {
      index.set(member, offset);
      offset += member.length;
    }
    const bytes = await collect(createZipStream([
      { name: "archive/data.warc.gz", source: warc.bytes },
      { name: "indexes/index.cdx.gz", source: index },
      { name: "indexes/index.idx", source: encode("ignored secondary index") },
      { name: "pages/pages.jsonl", source: encode('{"url":"https://example.com/","ts":"2026"}\n') },
      { name: "datapackage.json", source: encode('{"profile":"data-package","wacz_version":"1.1.1","resources":[]}') },
    ]));
    const wacz = await openWacz(createByteSource(bytes));
    expect((await wacz.readIndex()).map((record) => record.url)).toEqual([
      "https://example.com/",
      "https://example.com/style.css",
    ]);
    // A page file without the header line still parses.
    expect(await wacz.readPages()).toHaveLength(1);
  });

  it("refuses a package that is not a WACZ data package", async () => {
    const bytes = await collect(createZipStream([
      { name: "datapackage.json", source: encode('{"profile":"other","resources":[]}') },
    ]));
    await expect(openWacz(createByteSource(bytes))).rejects.toMatchObject({ code: "invalid-archive" });
    const none = await collect(createZipStream([{ name: "a.txt", source: encode("a") }]));
    await expect(openWacz(createByteSource(none))).rejects.toMatchObject({ code: "invalid-archive" });
  });

  it("refuses reserved paths and bad WARC names when writing", () => {
    const base = { warcs: [{ name: "a.warc", source: encode("") }], pages: [], index: "" };
    expect(() => createWaczStream({ ...base, files: [{ name: "archive/x", source: encode("") }] })).toThrow(TypeError);
    expect(() => createWaczStream({ ...base, warcs: [{ name: "../a.warc", source: encode("") }] })).toThrow(TypeError);
    expect(() => createWaczStream({ ...base, warcs: [{ name: "a.zip", source: encode("") }] })).toThrow(TypeError);
  });
});
