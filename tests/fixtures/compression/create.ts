/** Independent Node zlib/gzip producer and native reciprocal consumers; no candidate imports. */
import { Buffer } from "node:buffer";
import { readFileSync } from "node:fs";
import { deflateRawSync, deflateSync, gunzipSync, gzipSync, inflateRawSync, inflateSync } from "node:zlib";
import process from "node:process";
import { crc32, encoded, equal, options, producer, publish } from "../codec.ts";

const args = options(["output"]);
const tar: unknown = JSON.parse(readFileSync(new URL("../tar/independent.json", import.meta.url), "utf8"));
if (
  typeof tar !== "object" || tar === null || !("pax" in tar) || typeof tar.pax !== "object" || tar.pax === null ||
  !("archive" in tar.pax) || typeof tar.pax.archive !== "string"
) throw new Error("Expected independent PAX archive.");
const tarBytes = Buffer.from(tar.pax.archive, "base64");
const payload = Buffer.concat([
  Buffer.from(Array.from({ length: 256 }, (_, index) => index)),
  Buffer.from("independent compression payload\x00\xff", "latin1"),
]);
const formats: Record<string, unknown> = {};
for (const kind of ["gzip", "deflate", "deflate-raw"]) {
  const encode = kind === "gzip" ? gzipSync : kind === "deflate" ? deflateSync : deflateRawSync;
  const decode = kind === "gzip" ? gunzipSync : kind === "deflate" ? inflateSync : inflateRawSync;
  const compressed = encode(payload, { level: 6 });
  const empty = encode(Buffer.alloc(0), { level: 6 });
  const expanded = encode(Buffer.alloc(1024 * 1024, 65), { level: 6 });
  const packedTar = encode(tarBytes, { level: 6 });
  equal(decode(compressed), payload, kind);
  equal(decode(empty), Buffer.alloc(0), kind + " empty");
  equal(decode(expanded), Buffer.alloc(1024 * 1024, 65), kind + " expansion");
  equal(decode(packedTar), tarBytes, kind + " tar");
  formats[kind] = {
    bytes: encoded(compressed).base64,
    sha256: encoded(compressed).sha256,
    empty: empty.toString("base64"),
    expanded: expanded.toString("base64"),
    expandedSize: 1024 * 1024,
    tar: packedTar.toString("base64"),
  };
}
const ordinary = gzipSync(payload);
const header = Buffer.concat([
  ordinary.subarray(0, 10),
  Buffer.from([4, 0, 88, 0, 89, 255]),
  Buffer.from("fixture.bin\0independent producer\0"),
]);
header[3] = 0x1f;
const checksum = Buffer.alloc(2);
checksum.writeUInt16LE(crc32(header) & 0xffff);
const withHeaders = Buffer.concat([header, checksum, ordinary.subarray(10)]);
equal(gunzipSync(withHeaders), payload, "optional gzip headers");
publish(args.output!, {
  ...producer(import.meta.url),
  producer: "Node native zlib; not historical Python output",
  zlibVersion: process.versions.zlib,
  payload: payload.toString("base64"),
  formats,
  gzipHeaders: {
    bytes: withHeaders.toString("base64"),
    sha256: encoded(withHeaders).sha256,
    fhcrcOffset: header.length,
  },
});
