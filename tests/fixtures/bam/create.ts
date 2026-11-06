/** Authored SAM originals, independent Samtools readback and explicitly authored block geometry checks. */
import { equal, ok } from "node:assert/strict";
import { Buffer } from "node:buffer";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { gunzipSync } from "node:zlib";
import { check, record } from "../acquire.ts";
import { MIB, read, run, sha } from "../arrow/files.ts";
import type { CommandType } from "../arrow/files.ts";
import { SAMTOOLS } from "./artifacts.ts";
import { extractSource, inspectSource } from "./source.ts";

const { values } = parseArgs({ options: { artifacts: { type: "string" }, output: { type: "string" } } });
check(values.artifacts && values.output, "Require --artifacts and a fresh --output file.");
const artifacts = resolve(values.artifacts), commands: CommandType[] = [];
const admission = record(JSON.parse(read(join(artifacts, "admission.json"), 16 * 1024).toString("utf8")));
const archive = read(join(artifacts, "samtools-1.25.tar.bz2.snapshot"), 16 * MIB);
equal(archive.length, SAMTOOLS.bytes);
equal(sha(archive), SAMTOOLS.sha256);
equal(admission.release, "1.25");
equal(admission.sha256, sha(archive));
equal(admission.bytes, archive.length);
// Execution review is a separate receipt: never rewrite the inert acquisition's historical admission state.
const execution = record(JSON.parse(read(join(artifacts, "execution-admission.json"), 16 * 1024).toString("utf8")));
equal(execution.sha256, sha(archive));
equal(
  execution.reviewedForIsolatedTestExecution,
  true,
  "Root must explicitly admit this exact source archive for isolated test execution.",
);
const root = mkdtempSync(join(tmpdir(), "opfs-bam-native-")), primary: unknown[] = [];

/** This harness only measures block/record boundaries; it is not the candidate BAM decoder or a field oracle. */
function geometry(bytes: Buffer): { blocks: number; records: number; crossing: number } {
  const chunks: Buffer[] = [], boundaries: number[] = [];
  let at = 0, decoded = 0;
  while (at < bytes.length) {
    ok(at + 18 <= bytes.length);
    equal(bytes.readUInt16LE(at), 0x8b1f);
    equal(bytes[at + 2], 8);
    equal(bytes[at + 3], 4);
    const end = at + 12 + bytes.readUInt16LE(at + 10);
    ok(end <= bytes.length);
    let field = at + 12, size: number | undefined;
    while (field < end) {
      ok(field + 4 <= end);
      const length = bytes.readUInt16LE(field + 2);
      ok(field + 4 + length <= end);
      if (bytes[field] === 66 && bytes[field + 1] === 67) {
        equal(size, undefined);
        equal(length, 2);
        size = bytes.readUInt16LE(field + 4) + 1;
      }
      field += 4 + length;
    }
    ok(size !== undefined && size >= end - at + 8 && size <= 65536 && at + size <= bytes.length);
    const block = gunzipSync(bytes.subarray(at, at + size), { maxOutputLength: 65536 });
    equal(block.length, bytes.readUInt32LE(at + size - 4));
    decoded += block.length;
    ok(decoded <= 8 * MIB);
    chunks.push(block);
    boundaries.push(decoded);
    at += size;
    ok(chunks.length <= 1024);
  }
  const bam = Buffer.concat(chunks, decoded);
  equal(bam.subarray(0, 4).toString("latin1"), "BAM\x01");
  ok(bam.length >= 12);
  let position = 8 + bam.readUInt32LE(4);
  ok(position + 4 <= bam.length);
  const references = bam.readUInt32LE(position);
  position += 4;
  ok(references <= 64);
  for (let index = 0; index < references; index++) {
    ok(position + 4 <= bam.length);
    const length = bam.readUInt32LE(position);
    position += 4 + length + 4;
    ok(position <= bam.length);
  }
  let records = 0, crossing = 0;
  while (position < bam.length) {
    ok(position + 4 <= bam.length);
    const end = position + 4 + bam.readUInt32LE(position);
    ok(end >= position + 36 && end <= bam.length);
    if (boundaries.some((boundary) => boundary > position && boundary < end)) crossing++;
    position = end;
    ok(++records <= 1024);
  }
  equal(position, bam.length);
  return { blocks: chunks.length, records, crossing };
}

try {
  const admittedSource = inspectSource(artifacts);
  extractSource(admittedSource, root, "build");
  const members = admittedSource.members.filter((member) => member.kind === "file").map((member) => ({
    path: member.name,
    bytes: member.size,
    sha256: sha(member.data),
  }));
  const source = join(root, "samtools-1.25"), hts = join(source, "htslib-1.25");
  ok(
    members.some((member) => member.path === "samtools-1.25/htslib-1.25/htslib/hts.h"),
    "Expected bundled HTSlib 1.25 source identity is missing.",
  );
  const disabled = [
    "--disable-libcurl",
    "--disable-bz2",
    "--disable-lzma",
    "--without-libdeflate",
    "--disable-plugins",
    "--disable-s3",
    "--disable-gcs",
  ];
  run(["sh", "./configure", ...disabled], commands, hts);
  run(["make", "-j1", "libhts.a", "bgzip"], commands, hts);
  run(["sh", "./configure", "--without-curses", "--with-htslib=htslib-1.25", ...disabled], commands, source);
  run(["make", "-j1", "samtools"], commands, source);
  const samtools = join(source, "samtools"), bgzip = join(hts, "bgzip");
  const version = run([samtools, "--version"], commands);
  ok(/^samtools 1\.25\r?\nUsing htslib 1\.25\r?\n/.test(version));
  const header = "@HD\tVN:1.6\tSO:unknown\n@SQ\tSN:chr1\tLN:1000000\n@SQ\tSN:chr2\tLN:2000000\n";
  const sequence = "ACMGRSVTWYHKDBN=ACGTAC";
  const mixed = [
    [
      "read1",
      "0",
      "chr1",
      "1",
      "60",
      "5S10M2I3M2D4N1=1X2H",
      "*",
      "0",
      "0",
      sequence,
      "I".repeat(sequence.length),
      "AA:A:Z",
      "AB:i:-2147483648",
      "AC:i:4294967295",
      "AD:f:1.5",
      "AE:Z:ordered text",
    ].join("\t"),
    ["missing-quality", "16", "chr2", "12", "255", "4M", "*", "0", "0", "ACGT", "*"].join("\t"),
    ["absent", "4", "*", "0", "0", "*", "*", "0", "0", "*", "*"].join("\t"),
  ].join("\n") + "\n";
  const long = "ACGT".repeat(40000);
  const profiles = [
    { name: "header-only", sam: header, count: 0 },
    { name: "mixed", sam: header + mixed, count: 3 },
    { name: "no-reference", sam: "@HD\tVN:1.6\tSO:unknown\n" + mixed.split("\n")[2] + "\n", count: 1 },
    {
      name: "cross-block",
      sam: header +
        ["large", "0", "chr1", "1", "60", `${long.length}M`, "*", "0", "0", long, "I".repeat(long.length)].join("\t") +
        "\n",
      count: 1,
    },
  ];
  const cases = profiles.map((profile) => {
    const input = join(root, profile.name + ".sam"), output = join(root, profile.name + ".bam");
    writeFileSync(input, profile.sam, { flag: "wx" });
    run([samtools, "view", "--no-PG", "-b", "-o", output, input], commands);
    const restored = run([samtools, "view", "--no-PG", "-h", output], commands);
    equal(restored, profile.sam, `${profile.name}: complete native SAM readback differs from authored original.`);
    run([bgzip, "-t", output], commands);
    const bytes = read(output, 4 * MIB), layout = geometry(bytes);
    equal(layout.records, profile.count);
    if (profile.name === "cross-block") {
      ok(layout.crossing > 0, "Native fixture did not actually cross a BGZF block boundary.");
    }
    return {
      name: profile.name,
      originalSam: profile.sam,
      originalSha256: sha(Buffer.from(profile.sam)),
      bam: { bytes: bytes.length, sha256: sha(bytes), base64: bytes.toString("base64") },
      geometry: layout,
      completeNativeReadback: true,
    };
  });
  writeFileSync(
    resolve(values.output),
    JSON.stringify({
      profile: "samtools-1.25-bam-prefix-native-v1",
      sourceIdentity: SAMTOOLS,
      archiveSha256: sha(archive),
      version,
      sourceMembers: members,
      cases,
      commands,
      proof:
        "Samtools/HTSlib native writer and reader vs authored original SAM; shared native library, not two engines. Block geometry is an authored Node/zlib check. No candidate BAM parser or Python executed.",
    }) + "\n",
    { flag: "wx" },
  );
} catch (reason) {
  primary.push(reason);
} finally {
  try {
    rmSync(root, { recursive: true });
  } catch (reason) {
    primary.push(reason);
  }
}
// Presence is recorded by count: undefined and null remain actual terminal reasons.
if (primary.length === 1) throw primary[0];
if (primary.length > 1) throw new AggregateError(primary, "Native BAM work and cleanup failed.", { cause: primary[0] });
