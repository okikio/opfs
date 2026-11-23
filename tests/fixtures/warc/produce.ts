/** Author fixed WARC controls without importing the candidate reader.
 *
 * This is framing code and Node digest evidence, not a warcio validation run.
 * The independently produced historical fixture remains unchanged.
 * @module
 */
import { deepStrictEqual, ok } from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import process from "node:process";
import { parseArgs } from "node:util";

const { values } = parseArgs({ options: { output: { type: "string" } } });
ok(values.output, "Supply a new --output JSON path.");

/** RFC 4648 uppercase Base32 has no padding in a WARC labelled digest. */
function base32(bytes: Buffer): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0, accumulator = 0, result = "";
  for (const byte of bytes) {
    accumulator = (accumulator << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      result += alphabet.charAt((accumulator >>> bits) & 31);
    }
  }
  if (bits) result += alphabet.charAt((accumulator << (5 - bits)) & 31);
  return result;
}

function digest(bytes: Buffer, algorithm: "sha1" | "sha256"): string {
  return `${algorithm}:${base32(createHash(algorithm).update(bytes).digest())}`;
}

const entities = [
  Buffer.concat([Buffer.from("authored resource: café"), Buffer.from([0, 255]), Buffer.from("\r\nWARC/1.1\r\n\r\n")]),
  Buffer.from("authored HTTP entity\n"),
  Buffer.alloc(0),
];
type HistoricalType = { archives: { version: string; records: { entityBase64: string; blockBase64: string }[] }[] };
const historicalPath = new URL("./independent.json", import.meta.url);
ok(statSync(historicalPath).size <= 1024 * 1024, "Historical WARC input exceeds its bound.");
const historicalBytes = readFileSync(historicalPath);
ok(historicalBytes.length <= 1024 * 1024, "Historical WARC fixture exceeds its input bound.");
const historical: HistoricalType = JSON.parse(historicalBytes.toString("utf8"));
const archives = ["1.0", "1.1"].map((version) => {
  const old = historical.archives.find((archive) => archive.version === version);
  ok(old?.records.length === entities.length, "Historical WARC case identities changed.");
  const chunks: Buffer[] = [];
  const records = entities.map((entity, index) => {
    const type = index === 1 ? "response" : "resource";
    const block = index === 1
      ? Buffer.concat([
        Buffer.from(`HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: ${entity.length}\r\n\r\n`),
        entity,
      ])
      : entity;
    const prior = old.records[index];
    ok(prior, "Missing historical WARC record.");
    deepStrictEqual(entity, Buffer.from(prior.entityBase64, "base64"));
    deepStrictEqual(block, Buffer.from(prior.blockBase64, "base64"));
    const recordId = `<urn:uuid:00000000-0000-4000-8000-${String(index).padStart(12, "0")}>`;
    const blockDigest = digest(block, "sha1"), payloadDigest = digest(entity, "sha1");
    const header = [
      `WARC/${version}`,
      `WARC-Record-ID: ${recordId}`,
      "WARC-Date: 2026-11-05T00:00:00Z",
      `WARC-Type: ${type}`,
      "WARC-Target-URI: https://example.invalid/fixture",
      `WARC-Payload-Digest: ${payloadDigest}`,
      `WARC-Block-Digest: ${blockDigest}`,
      `Content-Type: ${type === "response" ? "application/http; msgtype=response" : "application/warc-record"}`,
      `Content-Length: ${block.length}`,
      "",
      "",
    ].join("\r\n");
    chunks.push(Buffer.from(header), block, Buffer.from("\r\n\r\n"));
    return {
      type,
      recordId,
      blockBase64: block.toString("base64"),
      entityBase64: entity.toString("base64"),
      blockDigest,
      payloadDigest,
      sha256BlockDigest: digest(block, "sha256"),
    };
  });
  const archive = Buffer.concat(chunks);
  return {
    version,
    base64: archive.toString("base64"),
    sha256: createHash("sha256").update(archive).digest("hex"),
    records,
  };
});
const receipt = JSON.stringify(
  {
    producer: "Authored TypeScript WARC framing and Node digests",
    runtime: process.version,
    proof: "Authored original bytes match historical record payloads; no independent parser was run",
    independentValidation: false,
    historicalFixtureSha256: createHash("sha256").update(historicalBytes).digest("hex"),
    archives,
  },
  null,
  2,
) + "\n";
ok(Buffer.byteLength(receipt) <= 1024 * 1024, "WARC receipt exceeds its output bound.");
writeFileSync(values.output, receipt, { flag: "wx" });
