/** Invoke hash-admitted native ARC producers/readers without a Python runtime.
 *
 * JWAT remains the independent complete stored-block consumer. The historical
 * warcio refusal/acceptance evidence is retained, but not rerun by this source.
 * @module
 */
import { deepStrictEqual, equal, ok } from "node:assert/strict";
import { Buffer } from "node:buffer";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";
import process from "node:process";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { command, read, sha } from "../iso/native.ts";
const { values } = parseArgs({
  options: { output: { type: "string" }, java: { type: "string" }, tools: { type: "string" } },
});
ok(
  values.output && values.java && values.tools && isAbsolute(values.java) && isAbsolute(values.tools),
  "Supply --java ABS_JDK_JAVA --tools ABS_PINNED_JARS --output NEW_JSON.",
);
const { java, tools } = values;
const here = fileURLToPath(new URL(".", import.meta.url)),
  historicalBytes = read(new URL("./independent.json", import.meta.url));
const historical: {
  artifacts: Record<string, string>;
  sourceReceipts: Record<string, string>;
  records: { base64: string }[];
} = JSON.parse(historicalBytes.toString("utf8"));
equal(Object.keys(historical.artifacts).length, 12, "Pinned ARC artifact set changed.");
for (const [name, digest] of Object.entries(historical.artifacts)) {
  ok(/^[a-z0-9][a-z0-9.-]*\.jar$/u.test(name) && /^[a-f0-9]{64}$/u.test(digest), "Malformed pinned artifact identity.");
  equal(sha(read(join(tools, name), 32 * 1024 * 1024)), digest, name);
}
const blocks = [
  Buffer.from("HTTP/1.1 200 OK\r\nContent-Length: 6\r\n\r\nhello\n"),
  Buffer.concat([
    Buffer.from(Array.from({ length: 256 }, (_, index) => index)),
    Buffer.from("\nhttp://fake.invalid/ 192.0.2.2 20260102030405 text/plain 0\n"),
  ]),
  Buffer.from("HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n"),
  Buffer.alloc(0),
];
deepStrictEqual(blocks.map((bytes) => bytes.toString("base64")), historical.records.map((record) => record.base64));
const classpath = Object.keys(historical.artifacts).filter((name) => !name.endsWith("-sources.jar")).map((name) =>
  join(tools, name)
).join(delimiter);
const root = mkdtempSync(join(tmpdir(), "opfs-arc-controls-")), failures: unknown[] = [];
try {
  for (const [index, bytes] of blocks.entries()) writeFileSync(join(root, "block" + index), bytes, { flag: "wx" });
  const commands = [];
  for (const harness of ["Produce.java", "ProduceJwat.java"]) {
    const source = read(join(here, harness), 1024 * 1024);
    const result = command(java, ["-Xmx64m", "-XX:MaxMetaspaceSize=128m", "-cp", classpath, join(here, harness), root]);
    commands.push({
      harness,
      sourceSha256: sha(source),
      stdout: result.stdout.toString("utf8"),
      stderr: result.stderr.toString("utf8"),
    });
  }
  const objects = [];
  for (
    const [filename, producer, prefix, mode] of [["jwat.arc", "JWAT1.2.1", "jwat-output", "outside-length"], [
      "genuine.arc",
      "IIPC3.0.5",
      "iipc-output",
      "inside-length",
    ]] as const
  ) {
    const data = read(join(root, filename));
    for (const [index, expected] of blocks.entries()) deepStrictEqual(read(join(root, prefix + (index + 1))), expected);
    const newline = data.indexOf(10);
    ok(newline > 0 && newline <= 4096);
    const header = data.subarray(0, newline).toString("ascii"), token = header.slice(header.lastIndexOf(" ") + 1);
    ok(/^\d+$/u.test(token));
    const size = Number(token);
    ok(Number.isSafeInteger(size) && size <= 4096);
    const rest = data.subarray(newline + 1), descriptor = rest.subarray(0, size);
    const canonical = Buffer.from(
      `1 0 ${
        mode === "outside-length" ? "OPFSFixture" : "InternetArchive"
      }\nURL IP-address Archive-date Content-type Archive-length\n${mode === "inside-length" ? "\n" : ""}`,
    );
    deepStrictEqual(descriptor, canonical);
    ok(
      rest.subarray(size).subarray(0, mode === "outside-length" ? 8 : 7).equals(
        Buffer.from(mode === "outside-length" ? "\nhttp://" : "http://"),
      ),
    );
    const status = read(join(root, prefix + "status"), 1024 * 1024).toString("utf8");
    equal(status.trimEnd().split("\n").length, 5);
    objects.push({
      producer,
      separator: mode,
      base64: data.toString("base64"),
      sha256: sha(data),
      descriptor: { base64: descriptor.toString("base64"), sha256: sha(descriptor) },
      nativeJwat: { strict: mode === "outside-length", status },
    });
  }
  const strict = read(join(root, "iipc-strict-outputstatus"), 1024 * 1024).toString("utf8");
  equal(strict.split("\n")[0]?.split(" ")[1], "false");
  // The exact source jar files were hash-admitted above. Retain the historical
  // per-source receipts as historical metadata rather than claiming fresh ZIP extraction.
  const receipt = JSON.stringify(
    {
      runtime: process.version,
      java: command(java, ["-version"]).stderr.toString("utf8"),
      historicalFixtureSha256: sha(historicalBytes),
      artifacts: historical.artifacts,
      commands,
      objects,
      records: blocks.map((bytes) => ({ base64: bytes.toString("base64"), sha256: sha(bytes) })),
      iipcStrictJwat: strict,
      historicalSourceReceipts: historical.sourceReceipts,
      warcioRerun: false,
      proof:
        "Unmodified native IIPC/JWAT producers, native JWAT full stored blocks, authored physical descriptor extents; historical warcio evidence not rerun",
    },
    null,
    2,
  ) + "\n";
  ok(Buffer.byteLength(receipt) <= 4 * 1024 * 1024, "ARC receipt exceeds its output bound.");
  writeFileSync(values.output, receipt, { flag: "wx" });
} catch (reason) {
  failures.push(reason);
} finally {
  try {
    rmSync(root, { recursive: true });
  } catch (reason) {
    failures.push(reason);
  }
}
if (failures.length === 1) throw failures[0];
if (failures.length) throw new AggregateError(failures, "ARC production and cleanup failed.");
