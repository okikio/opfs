/** Inert source admission shared by review and separately authorized native production. @module */
import { equal, ok } from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { gzipSync } from "node:zlib";
import { record, tar } from "../acquire.ts";
import type { MemberType } from "../acquire.ts";
import { MIB, read, sha } from "../arrow/files.ts";
import { SAMTOOLS } from "./artifacts.ts";

/** Members borrow one bounded TAR expansion; consumers must not retain them across unrelated work. */
export interface BamSourceType {
  readonly sha256: string;
  readonly archiveBytes: number;
  readonly expandedBytes: number;
  readonly members: readonly MemberType[];
  readonly expansion: {
    readonly argv: readonly string[];
    readonly timeoutMs: number;
    readonly maxOutputBytes: number;
    readonly stdoutBytes: number;
    readonly stdoutSha256: string;
    readonly stderrBytes: number;
    readonly stderrSha256: string;
  };
}

/**
 * Verify the exact acquired release before bounded system BZIP2 expansion. The
 * reviewed runtime's bzip2 is a format decoder, not an archived setup program.
 * TAR checksum/path/link admission precedes any archive-member writes. Neither
 * this function nor importing it executes configure, make or upstream source.
 */
export function inspectSource(artifacts: string): BamSourceType {
  const admission = record(JSON.parse(read(join(artifacts, "admission.json"), 16 * 1024).toString("utf8")));
  const archive = read(join(artifacts, "samtools-1.25.tar.bz2.snapshot"), 16 * MIB);
  equal(archive.length, SAMTOOLS.bytes);
  equal(sha(archive), SAMTOOLS.sha256);
  equal(admission.release, SAMTOOLS.version);
  equal(admission.sha256, SAMTOOLS.sha256);
  equal(admission.bytes, SAMTOOLS.bytes);
  equal(admission.executionAdmitted, false);
  const unpack = spawnSync("bzip2", ["-dc"], {
    input: archive,
    timeout: 30_000,
    killSignal: "SIGKILL",
    maxBuffer: 128 * MIB,
  });
  ok(
    unpack.error === undefined && unpack.status === 0 && unpack.signal === null,
    "Bounded source BZIP2 expansion failed.",
  );
  const inventory = tar(gzipSync(unpack.stdout, { level: 0 }), 128 * MIB, 12000);
  for (const member of inventory.members) {
    ok(member.name.startsWith("samtools-1.25/"), "Unexpected source root identity.");
    ok(member.kind !== "link", "Native source links require separate admission.");
  }
  ok(
    inventory.members.some((member) =>
      member.kind === "file" && member.name === "samtools-1.25/htslib-1.25/htslib/hts.h"
    ),
    "Expected bundled HTSlib 1.25 source identity is missing.",
  );
  return {
    sha256: SAMTOOLS.sha256,
    archiveBytes: archive.length,
    expandedBytes: inventory.expandedBytes,
    members: inventory.members,
    expansion: {
      argv: ["bzip2", "-dc"],
      timeoutMs: 30_000,
      maxOutputBytes: 128 * MIB,
      stdoutBytes: unpack.stdout.length,
      stdoutSha256: sha(unpack.stdout),
      stderrBytes: unpack.stderr.length,
      stderrSha256: sha(unpack.stderr),
    },
  };
}

/**
 * Write only the fully admitted tree beneath an already-owned fresh directory.
 * Review mode removes all executable bits. Build mode preserves ordinary archive
 * permissions, and is used only after create.ts checks execution-admission.json.
 */
export function extractSource(source: BamSourceType, root: string, mode: "review" | "build"): void {
  for (const member of source.members) {
    const target = join(root, member.name);
    if (member.kind === "directory") {
      mkdirSync(target, { recursive: true, mode: 0o700 });
      continue;
    }
    ok(member.kind === "file");
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    writeFileSync(target, member.data, { flag: "wx", mode: 0o600 });
    if (mode === "build") chmodSync(target, member.mode & 0o777);
  }
}
