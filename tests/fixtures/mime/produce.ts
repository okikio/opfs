/** Author MIME wire bytes and expected leaves without using the candidate parser.
 *
 * This source does not replace the historical CPython producer/parser evidence.
 * Its expected tree is authored from the original inputs, not decoded output.
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
const plain = Buffer.from("Plain café body.\r\n");
const html = Buffer.from("<p>HTML preview stays inert.</p>\r\n");
const attachment = Buffer.concat([Buffer.from([0, 1, 2, 13, 10, 255]), Buffer.from("authored attachment")]);
const historicalPath = new URL("./independent.json", import.meta.url);
ok(statSync(historicalPath).size <= 1024 * 1024, "Historical MIME input exceeds its bound.");
const historicalBytes = readFileSync(historicalPath);
const historical: { parts: { type: string; filename: string | null; payloadBase64: string | null }[] } = JSON.parse(
  historicalBytes.toString("utf8"),
);
const parts = [
  { type: "multipart/mixed", filename: null, payloadBase64: null },
  { type: "multipart/alternative", filename: null, payloadBase64: null },
  { type: "text/plain", filename: null, payloadBase64: plain.toString("base64") },
  { type: "text/html", filename: null, payloadBase64: html.toString("base64") },
  { type: "application/octet-stream", filename: "café.bin", payloadBase64: attachment.toString("base64") },
];
deepStrictEqual(parts, historical.parts, "Authored MIME leaf/tree controls differ from the retained original inputs.");

/** Quote every non-ASCII byte, preserving only CRLF as structural newlines. */
function quotedPrintable(bytes: Buffer): string {
  let result = "";
  for (const byte of bytes) {
    result += byte === 13 || byte === 10 || byte >= 33 && byte <= 126 && byte !== 61 || byte === 32
      ? String.fromCharCode(byte)
      : `=${byte.toString(16).toUpperCase().padStart(2, "0")}`;
  }
  return result;
}

const raw = Buffer.from([
  "From: sender@example.invalid",
  "To: reader@example.invalid",
  "Date: Thu, 05 Nov 2026 00:00:00 +0000",
  "Subject: =?utf-8?b?QSBjYWbDqSBtZXNzYWdl?=",
  "Message-ID: <fixture@example.invalid>",
  "MIME-Version: 1.0",
  'Content-Type: multipart/mixed; boundary="authored-mixed"',
  "",
  "Authored preamble",
  "--authored-mixed",
  'Content-Type: multipart/alternative; boundary="authored-alternative"',
  "",
  "--authored-alternative",
  'Content-Type: text/plain; charset="utf-8"',
  "Content-Transfer-Encoding: quoted-printable",
  "",
  quotedPrintable(plain),
  "--authored-alternative",
  'Content-Type: text/html; charset="utf-8"',
  "Content-Transfer-Encoding: base64",
  "",
  html.toString("base64"),
  "--authored-alternative--",
  "",
  "--authored-mixed",
  "Content-Type: application/octet-stream",
  "Content-Transfer-Encoding: base64",
  "Content-Disposition: attachment; filename*=utf-8''caf%C3%A9.bin",
  "",
  attachment.toString("base64"),
  "--authored-mixed--",
  "Authored epilogue",
  "",
].join("\r\n"));
const receipt = JSON.stringify(
  {
    producer: "Authored TypeScript MIME framing",
    runtime: process.version,
    proof: "Expected tree and complete original leaves match historical controls; no independent MIME parser was run",
    independentValidation: false,
    historicalFixtureSha256: createHash("sha256").update(historicalBytes).digest("hex"),
    sha256: createHash("sha256").update(raw).digest("hex"),
    base64: raw.toString("base64"),
    parts,
  },
  null,
  2,
) + "\n";
ok(Buffer.byteLength(receipt) <= 1024 * 1024, "MIME receipt exceeds its output bound.");
writeFileSync(values.output, receipt, { flag: "wx" });
