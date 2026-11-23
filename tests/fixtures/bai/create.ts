/** Authored regional truth against independent Samtools/HTSlib BAI and CSI queries. No candidate parser is imported. */
import { equal, ok } from "node:assert/strict";
import { Buffer } from "node:buffer";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { gunzipSync } from "node:zlib";
import { check, record } from "../acquire.ts";
import { MIB, read, run, sha } from "../arrow/files.ts";
import type { CommandType } from "../arrow/files.ts";
import { SAMTOOLS } from "../bam/artifacts.ts";
import { extractSource, inspectSource } from "../bam/source.ts";

/** Measured inert primary source identities; no document is executable or used as a candidate-generated oracle. */
const specifications = {
  repository: "https://github.com/samtools/hts-specs",
  commit: "510c107ba89aa13113818c9e4fa3071283cb7f7b",
  authority: "https://api.github.com/repos/samtools/hts-specs/commits/510c107ba89aa13113818c9e4fa3071283cb7f7b",
  documents: [
    { path: "SAMv1.tex", bytes: 92666, sha256: "5f1326a2298b37e9e6f375456189dfb5646a285dd0adf023c6a9344fd4fbc35a" },
    { path: "CSIv1.tex", bytes: 3791, sha256: "f91a2a7b6c866c2bc6b7ec89919cf52f2adcd48eb8903e11d5415c355350f396" },
  ],
  observation:
    "Official immutable-commit raw bytes measured 2026-11-06; source identity, not signature verification or independent index coverage proof.",
};
const { values } = parseArgs({ options: { artifacts: { type: "string" }, output: { type: "string" } } });
check(values.artifacts && values.output, "Require admitted --artifacts and a fresh --output file.");
check(!existsSync(resolve(values.output)), "Output must be a fresh evidence file.");
const artifacts = resolve(values.artifacts), commands: CommandType[] = [];
const execution = record(JSON.parse(read(join(artifacts, "execution-admission.json"), 16 * 1024).toString("utf8")));
equal(execution.sha256, SAMTOOLS.sha256);
equal(execution.reviewedForIsolatedTestExecution, true, "Exact Samtools source execution must be separately admitted.");
const root = mkdtempSync(join(tmpdir(), "opfs-bai-native-")), failures: unknown[] = [];

interface RowType {
  readonly line: string;
  readonly reference: string;
  /** Authored zero-based interval truth, not derived from candidate or native decoded output. */
  readonly start: number;
  readonly end: number;
}
interface RegionType {
  readonly name: string;
  readonly reference: string;
  readonly start: number;
  readonly end: number;
}
/** Construct authored SAM display values and independent explicit interval truth before native execution. */
function row(
  name: string,
  reference: string,
  position: number,
  cigar: string,
  sequence: string,
  end: number,
  flags = 0,
): RowType {
  const qualities = sequence === "*" ? "*" : "I".repeat(sequence.length);
  return {
    line: [name, flags, reference, position, flags & 4 ? 0 : 60, cigar, "*", 0, 0, sequence, qualities].join("\t") +
      "\n",
    reference,
    start: position - 1,
    end,
  };
}
const header = "@HD\tVN:1.6\tSO:coordinate\n@SQ\tSN:chr1\tLN:1000000\n@SQ\tSN:chr2\tLN:2000000\n";
const rows: readonly RowType[] = [
  row("first", "chr1", 1, "8M", "ACGTACGT", 8),
  row("duplicate", "chr1", 101, "4M", "ACGT", 104),
  row("duplicate", "chr1", 101, "4M", "ACGT", 104),
  row("window", "chr1", 16380, "10M", "ACGTACGTAC", 16389),
  row("deletion", "chr1", 20001, "2M5D2M", "ACGT", 20009),
  row("skip", "chr1", 30001, "2M10N2M", "ACGT", 30014),
  row("zero-reference-span", "chr1", 40001, "4I", "ACGT", 40001),
  row("crossing", "chr1", 50001, "160000M", "ACGT".repeat(40000), 210000),
  row("placed-unmapped", "chr1", 220000, "*", "ACGT", 220000, 4),
  row("second-reference", "chr2", 2, "4M", "ACGT", 5),
  row("unplaced", "*", 0, "*", "*", 0, 4),
];
const regions: readonly RegionType[] = [
  { name: "first-base", reference: "chr1", start: 0, end: 1 },
  { name: "distinct-identical-records", reference: "chr1", start: 100, end: 101 },
  { name: "16k-boundary", reference: "chr1", start: 16384, end: 16385 },
  { name: "inside-deletion", reference: "chr1", start: 20003, end: 20005 },
  { name: "inside-reference-skip", reference: "chr1", start: 30005, end: 30006 },
  { name: "zero-reference-span", reference: "chr1", start: 40000, end: 40001 },
  { name: "inside-crossing-record", reference: "chr1", start: 100000, end: 100001 },
  { name: "placed-unmapped", reference: "chr1", start: 219999, end: 220000 },
  { name: "empty-match", reference: "chr1", start: 300000, end: 300001 },
  { name: "second-reference", reference: "chr2", start: 1, end: 2 },
];
/** Expected output is authored before executing the query, including all header and duplicate-record bytes. */
function expected(text: string, originals: readonly RowType[], region: RegionType): string {
  return text +
    originals.filter((item) =>
      item.reference === region.reference && item.start < region.end && item.end > region.start
    ).map((item) => item.line).join("");
}
function blob(path: string): { readonly bytes: number; readonly sha256: string; readonly base64: string } {
  const bytes = read(path, 8 * MIB);
  return { bytes: bytes.length, sha256: sha(bytes), base64: bytes.toString("base64") };
}
/** Only a recorded nonzero native exit is an observation; transport/timeout failures remain qualification failures. */
function attempt(argv: readonly string[]): CommandType {
  const count = commands.length;
  try {
    run(argv, commands);
  } catch (reason) {
    if (commands.length === count) throw reason;
  }
  return commands.at(-1)!;
}
/** Narrow fixture observation of the native CSI header, not a reusable or candidate index parser. */
function csiGeometry(
  path: string,
): { readonly minShift: number; readonly depth: number; readonly auxiliaryBytes: number } {
  const raw = gunzipSync(read(path, 8 * MIB), { maxOutputLength: 16 * MIB });
  equal(raw.subarray(0, 4).toString("binary"), "CSI\x01");
  ok(raw.length >= 16);
  return { minShift: raw.readInt32LE(4), depth: raw.readInt32LE(8), auxiliaryBytes: raw.readInt32LE(12) };
}
try {
  const admitted = inspectSource(artifacts);
  extractSource(admitted, root, "build");
  const source = join(root, "samtools-1.25"), hts = join(source, "htslib-1.25");
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
  const bam = (name: string, originalSam: string): string => {
    const input = join(root, name + ".sam"), output = join(root, name + ".bam");
    writeFileSync(input, originalSam, { flag: "wx" });
    run([samtools, "view", "--no-PG", "-b", "-o", output, input], commands);
    equal(
      run([samtools, "view", "--no-PG", "-h", output], commands),
      originalSam,
      "Complete authored SAM readback differs.",
    );
    run([bgzip, "-t", output], commands);
    return output;
  };
  const index = (path: string, name: string, kind: "bai" | "csi"): string => {
    const target = join(root, name + "." + kind);
    run(
      [samtools, "index", kind === "bai" ? "-b" : "-c", ...(kind === "csi" ? ["-m", "14"] : []), "-o", target, path],
      commands,
    );
    return target;
  };
  const query = (path: string, indexPath: string, region: RegionType): CommandType => {
    return attempt([
      samtools,
      "view",
      "--no-PG",
      "-h",
      "-X",
      path,
      indexPath,
      `${region.reference}:${region.start + 1}-${region.end}`,
    ]);
  };
  const originalSam = header + rows.map((item) => item.line).join(""), path = bam("coordinate", originalSam);
  const bai = index(path, "coordinate", "bai"), csi = index(path, "coordinate", "csi");
  const nativeQueries = regions.map((region) => {
    const original = expected(header, rows, region);
    const baiRead = query(path, bai, region), csiRead = query(path, csi, region);
    equal(baiRead.code, 0);
    equal(csiRead.code, 0);
    equal(baiRead.stdout, original, "BAI query differs from complete authored selection.");
    equal(csiRead.stdout, original, "CSI query differs from complete authored selection.");
    return {
      ...region,
      expectedSam: original,
      expectedSha256: sha(Buffer.from(original)),
      bai: { completeNativeReadback: true },
      csi: { completeNativeReadback: true },
    };
  });
  const unmappedExpected = header + rows.at(-1)!.line;
  const unmappedBai = attempt([samtools, "view", "--no-PG", "-h", "-X", path, bai, "*"]);
  const unmappedCsi = attempt([samtools, "view", "--no-PG", "-h", "-X", path, csi, "*"]);
  equal(unmappedBai.code, 0);
  equal(unmappedCsi.code, 0);
  equal(unmappedBai.stdout, unmappedExpected);
  equal(unmappedCsi.stdout, unmappedExpected);
  const highHeader = "@HD\tVN:1.6\tSO:coordinate\n@SQ\tSN:large\tLN:1000000000\n";
  const highRows = [row("beyond-bai", "large", 600000001, "4M", "ACGT", 600000004)];
  const highOriginal = highHeader + highRows[0]!.line, highPath = bam("high-coordinate", highOriginal);
  const highCsi = index(highPath, "high-coordinate", "csi");
  const highRegion = { name: "beyond-2pow29", reference: "large", start: 600000000, end: 600000001 };
  const highExpected = expected(highHeader, highRows, highRegion), highRead = query(highPath, highCsi, highRegion);
  equal(highRead.code, 0);
  equal(highRead.stdout, highExpected);
  const highBai = attempt([samtools, "index", "-b", "-o", join(root, "high-coordinate.bai"), highPath]);
  ok(highBai.code !== 0, "Native BAI unexpectedly admitted a record beyond 2^29.");
  const unsortedPath = bam("out-of-order", header + rows[3]!.line + rows[0]!.line);
  const unsorted = attempt([samtools, "index", "-b", "-o", join(root, "out-of-order.bai"), unsortedPath]);
  ok(unsorted.code !== 0, "Native index unexpectedly admitted descending coordinates.");

  // Wrong-pair and omitted-index behavior is observed, never used as universal refusal authority.
  const wrongRows = rows.filter((_, ordinal) => ordinal !== 7),
    wrongSam = header + wrongRows.map((item) => item.line).join("");
  const wrongPath = bam("same-header-other-records", wrongSam),
    wrongBai = index(wrongPath, "same-header-other-records", "bai");
  const wrongRegion = regions.find((region) => region.name === "inside-crossing-record")!;
  const wrongExpected = expected(header, rows, wrongRegion), wrong = query(path, wrongBai, wrongRegion);
  // Authored BAI with the exact native reference count, but no bins/chunks/linear entries. No native claim for these bytes.
  const nativeBai = read(bai, 8 * MIB);
  equal(nativeBai.subarray(0, 4).toString("binary"), "BAI\x01");
  const references = nativeBai.readUInt32LE(4);
  equal(references, 2);
  const omitted = Buffer.alloc(8 + references * 8);
  nativeBai.copy(omitted, 0, 0, 8);
  const omittedPath = join(root, "authored-omitted-chunks.bai");
  writeFileSync(omittedPath, omitted, { flag: "wx" });
  const omittedRead = query(path, omittedPath, wrongRegion);
  const observe = (name: string, command: CommandType, truth: string) => ({
    name,
    exitCode: command.code,
    stdout: command.stdout,
    stderr: command.stderr,
    expectedSam: truth,
    matchesAuthoredTruth: command.code === 0 && command.stdout === truth,
  });
  const sourceFiles = admitted.members.filter((member) => member.kind === "file").map((member) => ({
    path: member.name,
    bytes: member.size,
    sha256: sha(member.data),
  }));
  writeFileSync(
    resolve(values.output),
    JSON.stringify({
      profile: "samtools-1.25-bai-csi-native-v1",
      specifications,
      sourceIdentity: SAMTOOLS,
      version,
      sourceInventory: { count: sourceFiles.length, sha256: sha(Buffer.from(JSON.stringify(sourceFiles))) },
      cases: [
        {
          name: "coordinate",
          originalSam,
          originalSha256: sha(Buffer.from(originalSam)),
          bam: blob(path),
          bai: blob(bai),
          csi: blob(csi),
          csiGeometry: csiGeometry(csi),
          queries: nativeQueries,
        },
        {
          name: "high-coordinate",
          originalSam: highOriginal,
          originalSha256: sha(Buffer.from(highOriginal)),
          bam: blob(highPath),
          csi: blob(highCsi),
          csiGeometry: csiGeometry(highCsi),
          queries: [{
            ...highRegion,
            expectedSam: highExpected,
            expectedSha256: sha(Buffer.from(highExpected)),
            completeNativeReadback: true,
          }],
        },
      ],
      controls: {
        nativeUnplacedTail: {
          expectedSam: unmappedExpected,
          bai: unmappedBai,
          csi: unmappedCsi,
          scope: "Native star-region behavior only; no public unmapped-tail API is implemented.",
        },
        highCoordinateBai: highBai,
        descendingCoordinates: unsorted,
        wrongPair: {
          originalBamSha256: blob(path).sha256,
          otherBam: blob(wrongPath),
          otherOriginalSam: wrongSam,
          otherIndex: blob(wrongBai),
          observation: observe("same-header-wrong-index", wrong, wrongExpected),
        },
        omittedChunks: {
          origin: "authored BAI framing with zero bins/chunks/intervals; not a native-produced index",
          index: blob(omittedPath),
          observation: observe("omitted-chunks", omittedRead, wrongExpected),
        },
      },
      commands,
      proof:
        "Native Samtools/HTSlib writes, indexes and queries against authored complete SAM truth; same native library, independent of candidate code. Wrong-index/omission responses are observations, not universal pairing or completeness proof. No candidate parser or Python executed.",
    }) + "\n",
    { flag: "wx" },
  );
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
if (failures.length > 1) {
  throw new AggregateError(failures, "Native indexed BAM work and cleanup failed.", { cause: failures[0] });
}
