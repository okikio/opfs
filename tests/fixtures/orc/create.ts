/** Apache C++ ORC writes and reads every original; both directions share one native implementation. */
import { deepStrictEqual, equal, ok } from "node:assert/strict";
import { Buffer } from "node:buffer";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { versions } from "node:process";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { MIB, read, run, sha } from "../arrow/files.ts";
import { prepare } from "../arrow/native.ts";
import { blob, compare, originals, retained, save } from "../arrow/values.ts";

type FieldType = bigint | Buffer;
/** Authored protobuf envelope inspection owns encoding receipts, never expected decoded values. */
function wire(body: Buffer): Map<number, FieldType[]> {
  let at = 0;
  function integer(): bigint {
    let value = 0n;
    for (let shift = 0n; shift < 70n; shift += 7n) {
      ok(at < body.length);
      const byte = body[at++]!;
      value |= BigInt(byte & 127) << shift;
      if (byte < 128) {
        ok(value < 1n << 64n);
        return value;
      }
    }
    throw new Error("Native wire varint exceeds uint64.");
  }
  const fields = new Map<number, FieldType[]>();
  while (at < body.length) {
    const tag = integer(), field = Number(tag >> 3n), kind = Number(tag & 7n);
    ok(field > 0 && field < 1 << 29);
    let value: FieldType;
    if (kind === 0) value = integer();
    else if ([1, 2, 5].includes(kind)) {
      const length = kind === 2 ? Number(integer()) : kind === 1 ? 8 : 4;
      ok(Number.isSafeInteger(length) && length >= 0 && length <= body.length - at);
      value = body.subarray(at, at + length);
      at += length;
    } else throw new Error("Native wire group/invalid tag.");
    const list = fields.get(field) ?? [];
    list.push(value);
    fields.set(field, list);
  }
  return fields;
}
function number(fields: Map<number, FieldType[]>, key: number, fallback?: number): number {
  const value = fields.get(key)?.at(-1);
  if (value === undefined && fallback !== undefined) return fallback;
  ok(typeof value === "bigint" && value >= 0n && value <= BigInt(Number.MAX_SAFE_INTEGER));
  return Number(value);
}
function buffer(value: FieldType): Buffer {
  ok(Buffer.isBuffer(value));
  return value;
}

const { values: args } = parseArgs({ options: { artifacts: { type: "string" }, output: { type: "string" } } });
if (args.artifacts === undefined || args.output === undefined) {
  throw new TypeError("--artifacts and a new --output path are required.");
}
const native = prepare(args.artifacts, false), fixtures: Record<string, unknown>[] = [];
let accounting = 0;
try {
  for (const minor of [11, 12]) {
    for (const rows of [0, 37, 8192]) {
      for (const nulls of ["none", "mixed", "all"]) {
        const columns = originals(
          ["b", "y", "s", "i", "q", "f", "d"],
          rows,
          (index) => nulls === "all" || nulls === "mixed" && index % 5 === 0,
        );
        const name = `0.${minor}-${rows}-${nulls}.orc`, folder = join(native.root, name);
        mkdirSync(folder);
        save(folder, columns);
        run([native.binary, "write", "orc", folder, String(rows), String(minor)], native.commands);
        const path = join(folder, "native.orc"), decoded = join(folder, "decoded"), image = read(path, 2 * MIB);
        run([native.binary, "read", "orc", path, decoded], native.commands);
        compare(decoded, columns);
        const metadata = new Map(
          read(join(decoded, "metadata.tsv"), MIB).toString().trimEnd().split("\n").map((line) => {
            const item = line.split("\t");
            return [item[0]!, Number(item[1])] as const;
          }),
        );
        equal(metadata.get("rows"), rows);
        deepStrictEqual(image.subarray(0, 3), Buffer.from("ORC"));
        const postStart = image.length - 1 - image.at(-1)!;
        ok(postStart >= 3);
        const post = wire(image.subarray(postStart, -1));
        equal(number(post, 2, 0), 0);
        const version = post.get(4)!;
        ok(version !== undefined);
        if (version.length === 1 && Buffer.isBuffer(version[0])) deepStrictEqual(version[0], Buffer.from([0, minor]));
        else deepStrictEqual(version, [0n, BigInt(minor)]);
        const footerStart = postStart - number(post, 1);
        ok(footerStart >= 3);
        const footer = wire(image.subarray(footerStart, postStart));
        const metadataStart = footerStart - number(post, 5, 0),
          header = number(footer, 1),
          declared = number(footer, 2);
        ok(metadataStart >= 3);
        const basis = declared + header === metadataStart
          ? "body"
          : declared === metadataStart
          ? "header-and-body"
          : null;
        ok(basis !== null, "Native contentLength equation differs from admitted profiles.");
        const stripes = (footer.get(3) ?? []).map((raw) => {
          const stripe = wire(buffer(raw));
          const [offset, index, body, length, count] = [1, 2, 3, 4, 5].map((key) => number(stripe, key, 0)) as [
            number,
            number,
            number,
            number,
            number,
          ];
          ok(offset >= 3 && offset + index + body + length <= metadataStart);
          const info = wire(image.subarray(offset + index + body, offset + index + body + length));
          const kinds = (info.get(2) ?? []).map((value) => number(wire(buffer(value)), 1, 0));
          equal(kinds.length, 8);
          equal(kinds[0], 0);
          for (let column = 1; column < 8; column++) {
            equal(kinds[column], minor === 12 && [3, 4, 5].includes(column) ? 2 : 0);
          }
          return { offset, indexBytes: index, dataBytes: body, footerBytes: length, rows: count, encodings: kinds };
        });
        equal(stripes.length, metadata.get("stripes"));
        equal(stripes.reduce((sum, stripe) => sum + stripe.rows, 0), rows);
        if (rows === 8192 && nulls === "none") {
          ok(stripes.length > 1, "Native stripe settings did not produce a multi-stripe image.");
        }
        accounting += image.length +
          columns.reduce((sum, item) => sum + item.physical.length + item.validity.length, 0);
        ok(accounting <= 16 * MIB);
        fixtures.push({
          name,
          fileVersion: `0.${minor}`,
          rows,
          nulls,
          file: blob(image),
          columns: retained(columns),
          stripes,
          contentLengthBasis: basis,
        });
      }
    }
  }
  equal(fixtures.length, 18);
  const encoded = JSON.stringify({
    fixtures,
    qualification:
      "Arrow C++ ORC writer/reader share one implementation; changed launcher, not a Python rerun or second native engine",
    fixtureAccountingBytes: accounting,
    commands: native.commands,
    sourceSha256: native.sourceSha256,
    sources: native.sources,
    admission: JSON.parse(read(join(native.artifacts, "admission.json")).toString()) as unknown,
    producerSha256: sha(read(fileURLToPath(import.meta.url))),
    tools: { compiler: run(["c++", "--version"], native.commands), node: versions },
  });
  ok(Buffer.byteLength(encoded) <= 32 * MIB);
  writeFileSync(resolve(args.output), encoded + "\n", { flag: "wx" });
} finally {
  native.close();
}
