/** Native Samtools output is compared with complete authored SAM originals, never candidate-generated expectations. */
import { describe, it } from "node:test";
import { expect } from "@std/expect";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { gunzipSync, gzipSync } from "node:zlib";
import { ArchiveError, openBam } from "../src/dataset/bam.ts";
import type { BamDatasetType, BamRecordType } from "../src/dataset/bam.ts";
import type { ByteSourceType } from "../src/source.ts";
import { createByteSource } from "../src/source.ts";

interface FixtureType {
  readonly name: string;
  readonly originalSam: string;
  readonly originalSha256: string;
  readonly bam: { readonly bytes: number; readonly sha256: string; readonly base64: string };
  readonly geometry: { readonly blocks: number; readonly records: number; readonly crossing: number };
}
function fixtures(): readonly FixtureType[] {
  const bytes = readFileSync(new URL("./fixtures/bam/native/corpus.json", import.meta.url));
  expect(bytes.length).toBe(325349);
  expect(createHash("sha256").update(bytes).digest("hex")).toBe(
    "4b18297001bdc669a16801340dcb7e5847c073a5aa577cd6baf0c59de5297ebf",
  );
  return (JSON.parse(bytes.toString()) as { cases: FixtureType[] }).cases;
}
function image(item: FixtureType): Buffer<ArrayBuffer> {
  const bytes = Buffer.from(item.bam.base64, "base64");
  expect(bytes.length).toBe(item.bam.bytes);
  expect(createHash("sha256").update(bytes).digest("hex")).toBe(item.bam.sha256);
  expect(createHash("sha256").update(item.originalSam).digest("hex")).toBe(item.originalSha256);
  return bytes;
}
function fixture(name = "mixed"): FixtureType {
  return fixtures().find((item) => item.name === name)!;
}
/** SAM rendering is test-only normalization of numeric BAM widths; every display value is compared with authored text. */
function sam(record: BamRecordType, dataset: BamDatasetType): string {
  const reference = (id: number): string => id < 0 ? "*" : dataset.header.references[id]!.name;
  const mate = record.mateReferenceId >= 0 && record.mateReferenceId === record.referenceId
    ? "="
    : reference(record.mateReferenceId);
  const quality = record.qualities === null
    ? "*"
    : Array.from(record.qualities, (value) => String.fromCharCode(value + 33)).join("");
  const auxiliary = record.auxiliary.map((field) =>
    `${field.tag}:${"cCsSiI".includes(field.type) ? "i" : field.type}:${field.value}`
  );
  return [
    record.name,
    record.flags,
    reference(record.referenceId),
    record.position + 1,
    record.mappingQuality,
    record.cigar.map((part) => `${part.length}${part.operation}`).join("") || "*",
    mate,
    record.matePosition + 1,
    record.templateLength,
    record.sequence ?? "*",
    quality,
    ...auxiliary,
  ].join("\t") + "\n";
}
/** Explicit failure presence preserves raw undefined/null reasons, unlike a sentinel-valued capture. */
async function failure(action: () => Promise<unknown>): Promise<{ readonly reason: unknown }> {
  try {
    await action();
  } catch (reason) {
    return { reason };
  }
  throw new Error("Expected authored refusal, but operation resolved.");
}
async function collect(dataset: BamDatasetType): Promise<BamRecordType[]> {
  const records: BamRecordType[] = [];
  for await (const page of dataset.records({ maxRecords: 100, pageRecords: 1 })) records.push(...page.records);
  return records;
}
/** Native gzip supplies raw DEFLATE and its CRC/ISIZE; authored framing adds the independently specified BGZF BC field. */
function block(decoded: Uint8Array): Buffer<ArrayBuffer> {
  const gzip = gzipSync(decoded), bytes = Buffer.alloc(gzip.length + 8);
  bytes.set([31, 139, 8, 4, 0, 0, 0, 0, 0, 255, 6, 0, 66, 67, 2, 0]);
  expect(bytes.length <= 65536).toBe(true);
  bytes.writeUInt16LE(bytes.length - 1, 16);
  bytes.set(gzip.subarray(10), 18);
  return bytes;
}
function repack(decoded: Uint8Array): Buffer<ArrayBuffer> {
  return Buffer.concat([block(decoded), image(fixture()).subarray(-28)]);
}
/** Locate record bytes using the BAM header's independent fixed grammar, not the candidate reader. */
function firstRecord(bytes: Buffer): number {
  let at = 8 + bytes.readInt32LE(4);
  const references = bytes.readInt32LE(at);
  at += 4;
  for (let i = 0; i < references; i++) at += 8 + bytes.readInt32LE(at);
  return at;
}

describe("BAM bounded prefix reader", () => {
  it("matches every original SAM byte for all four native profiles, including the crossing record", async () => {
    for (const item of fixtures()) {
      const dataset = await openBam(createByteSource(image(item)));
      let actual = dataset.header.text, ended = false;
      for await (const page of dataset.records({ maxRecords: 100, pageRecords: 1 })) {
        actual += page.records.map((record) => sam(record, dataset)).join("");
        expect(page.verification).toBe("checked-blocks");
        if (page.end === "eof") ended = true;
      }
      expect(actual).toBe(item.originalSam);
      expect(ended).toBe(true);
      expect(dataset.inspect().records).toBe(item.geometry.records);
      expect(dataset.inspect().blocks).toBe(item.geometry.blocks);
      expect(Object.isFrozen(dataset.header)).toBe(true);
      expect(Object.isFrozen(dataset.header.references)).toBe(true);
      for (const reference of dataset.header.references) expect(Object.isFrozen(reference)).toBe(true);
    }
  });

  it("separates preview count from EOF and does not probe the next record", async () => {
    const bytes = image(fixture());
    let reads = 0;
    const source: ByteSourceType = {
      size: bytes.length,
      stability: "caller",
      async read(offset, length) {
        reads++;
        return bytes.subarray(offset, offset + length);
      },
    };
    const dataset = await openBam(source), openingReads = reads;
    const zeroIterator = dataset.records({ maxRecords: 0 });
    const zero = await zeroIterator.next();
    expect(zero.value?.end).toBe("preview");
    expect(zero.value?.records).toEqual([]);
    expect(reads).toBe(openingReads);
    await zeroIterator.return(undefined);
    const iterator = dataset.records({ maxRecords: 1, pageRecords: 1 });
    const page = await iterator.next();
    expect(page.value?.records.length).toBe(1);
    expect(page.value?.end).toBe("preview");
    const stopped = reads;
    await iterator.next();
    expect(reads).toBe(stopped);
    // A count equal to the true total is still a preview; no suffix probe establishes natural EOF.
    const exact = dataset.records({ maxRecords: 3 });
    expect((await exact.next()).value?.end).toBe("preview");
    await exact.return(undefined);
    expect((await collect(dataset)).length).toBe(3);
  });

  it("returns owned stable bytes, keeps absent quality distinct, and preserves ordered scalar encodings", async () => {
    const dataset = await openBam(createByteSource(image(fixture()))), records = await collect(dataset);
    expect(records[0]!.auxiliary.map((field) => field.tag)).toEqual(["AA", "AB", "AC", "AD", "AE"]);
    expect(records[0]!.auxiliary.map((field) => field.type)).toEqual(["A", "i", "I", "f", "Z"]);
    expect(records[1]!.sequence).toBe("ACGT");
    expect(records[1]!.qualities).toBe(null);
    expect(records[2]!.sequence).toBe(null);
    expect(records[2]!.qualities).toBe(null);
    records[0]!.qualities![0] = 0;
    const repeated = await collect(dataset);
    expect(repeated[0]!.qualities![0]).toBe(40);
    expect(records[0]!.name).toBe("read1");
  });

  it("does not treat an interior canonical empty block as EOF", async () => {
    const bytes = image(fixture()), firstSize = bytes.readUInt16LE(16) + 1;
    const withEmpty = Buffer.concat([bytes.subarray(0, firstSize), bytes.subarray(-28), bytes.subarray(firstSize)]);
    const dataset = await openBam(createByteSource(withEmpty));
    expect((await collect(dataset)).length).toBe(3);
    expect(dataset.inspect().blocks).toBe(4);
  });

  it("retains source/abort reasons and never closes a borrowed source", async () => {
    for (const reason of [undefined, null, new Error("authored source failure")]) {
      let closes = 0;
      const source = {
        size: 28,
        stability: "caller" as const,
        read(): Promise<Uint8Array> {
          return Promise.reject(reason);
        },
        close() {
          closes++;
        },
      };
      expect((await failure(() => openBam(source))).reason).toBe(reason);
      expect(closes).toBe(0);
    }
    const bytes = image(fixture()), opening = new AbortController(), reading = new AbortController();
    const dataset = await openBam(createByteSource(bytes), { signal: opening.signal });
    opening.abort(new Error("opening no longer owns iteration"));
    const iterator = dataset.records({ signal: reading.signal, pageRecords: 1 });
    await iterator.next();
    const reason = new Error("authored iteration cancellation");
    reading.abort(reason);
    expect((await failure(() => iterator.next())).reason).toBe(reason);
    expect((await collect(dataset)).length).toBe(3);
  });

  it("releases single-iterator ownership on early return and rejects overlapping iterators", async () => {
    const dataset = await openBam(createByteSource(image(fixture())));
    const first = dataset.records({ pageRecords: 1 });
    await first.next();
    expect((await failure(() => dataset.records().next())).reason).toBeInstanceOf(TypeError);
    await first.return(undefined);
    expect((await collect(dataset)).length).toBe(3);
  });

  it("shares physical, decoded, returned-storage, record and DEFLATE budgets across lifetime operations", async () => {
    const bytes = image(fixture());
    for (
      const options of [
        { maxSourceBytes: 0 },
        { maxRequests: 0 },
        { maxDecodedBytes: 0 },
        { maxOutputBytes: 0 },
        { maxBlocks: 0 },
        { maxDeflateBlocks: 0 },
        { maxHeaderLines: 0 },
        { maxReferences: 0 },
      ]
    ) {
      const reason = (await failure(() => openBam(createByteSource(bytes), options))).reason;
      expect(reason).toBeInstanceOf(ArchiveError);
      expect((reason as ArchiveError).code).toBe("budget-exceeded");
    }
    const dataset = await openBam(createByteSource(bytes), { maxTotalRecords: 1 });
    const first = dataset.records({ maxRecords: 1 });
    await first.next();
    await first.return(undefined);
    const reason = (await failure(() => dataset.records({ maxRecords: 1 }).next())).reason;
    expect((reason as ArchiveError).code).toBe("budget-exceeded");
    expect(dataset.inspect().records).toBe(1);
  });

  it("refuses malformed block/header/record profiles before returning a partial record", async () => {
    const original = image(fixture());
    const plain = gunzipSync(original), at = firstRecord(plain);
    const controls: { name: string; bytes: Buffer }[] = [];
    const mutate = (name: string, change: (bytes: Buffer) => void): void => {
      const bytes = Buffer.from(plain);
      change(bytes);
      controls.push({ name, bytes: repack(bytes) });
    };
    mutate("negative header text", (bytes) => bytes.writeInt32LE(-1, 4));
    mutate("record extent", (bytes) => bytes.writeInt32LE(0x7fffffff, at));
    mutate("reference ID", (bytes) => bytes.writeInt32LE(99, at + 4));
    mutate("sequence length", (bytes) => bytes.writeInt32LE(-1, at + 20));
    mutate("query NUL", (bytes) => {
      bytes[at + 4 + 32 + bytes[at + 12]! - 1] = 65;
    });
    mutate("CG refusal", (bytes) => {
      const aux = bytes.indexOf(Buffer.from("AAA"), at);
      expect(aux > at).toBe(true);
      bytes[aux] = 67;
      bytes[aux + 1] = 71;
    });
    mutate("B array refusal", (bytes) => {
      const aux = bytes.indexOf(Buffer.from("AAA"), at);
      bytes[aux + 2] = 66;
    });
    const crc = Buffer.from(original);
    crc[crc.readUInt16LE(16) - 6]! ^= 1;
    controls.push({ name: "CRC", bytes: crc });
    const flags = Buffer.from(original);
    flags[3] = 12;
    controls.push({ name: "optional header flags", bytes: flags });
    const bsize = Buffer.from(original);
    bsize.writeUInt16LE(1, 16);
    controls.push({ name: "BSIZE", bytes: bsize });
    const marker = Buffer.from(original);
    marker[marker.length - 1] = 1;
    controls.push({ name: "physical marker", bytes: marker });
    for (const control of controls) {
      const failed = await failure(async () => collect(await openBam(createByteSource(control.bytes))));
      if (!(failed.reason instanceof ArchiveError)) {
        throw new Error(`Expected format/profile/budget refusal for ${control.name}`, { cause: failed.reason });
      }
    }
  });
});
