/** Pinned age artifacts and original CCTV vectors, retained inert with bounded expansion. */
import { Buffer } from "node:buffer";
import { readFileSync, statSync } from "node:fs";
import { basename } from "node:path";
import process from "node:process";
import { parseArgs } from "node:util";
import { inflateSync } from "node:zlib";
import {
  check,
  digest,
  fetchBytes,
  gitBlob,
  integer,
  json,
  output,
  record,
  safe,
  snapshot,
  tar,
  text,
} from "../../acquire.ts";
const ASSET = "https://github.com/FiloSottile/age/releases/download/v1.3.2/age-v1.3.2-linux-arm64.tar.gz";
const ASSET_BYTES = 17771923;
const ASSET_SHA = "6b8dc4333c53a5a57c9e5834e3a48f92605d7154014cd07269ff3327db5d37f4";
const CCTV = "4448f2097b2daa812c91a26141f9f36c2096b9ca";
const REVISIONS: Readonly<Record<string, string>> = {
  "FiloSottile/age": "b74dce4cdbe35b5e5f66c06d9612b72f89028758",
  "C2SP/C2SP": "037e546d164a89fd7577df2c18df80bb54bd246e",
  "C2SP/CCTV": CCTV,
};
const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    output: { type: "string" },
    manifest: { type: "string", default: "/tool/age-vectors.json" },
    sources: { type: "string", default: "/tool/age-sources.json" },
  },
});
check(
  values.output && positionals.length === 1 && ["cli", "vectors"].includes(positionals[0]!),
  "Usage: age-acquire.ts cli|vectors --output FRESH_PATH [--manifest PATH --sources PATH]",
);
const deadline = Date.now() + 120_000;
function identity(bytes: Uint8Array): { bytes: number; sha256: string } {
  return { bytes: bytes.byteLength, sha256: digest(bytes) };
}
function manifest(path: string): Record<string, unknown> {
  check(statSync(path).size <= 512 * 1024, "Manifest byte ceiling.");
  return record(JSON.parse(readFileSync(path, "utf8")));
}
async function cli(root: string): Promise<unknown> {
  const raw = await fetchBytes(
    ASSET,
    ASSET_BYTES,
    deadline,
    (_from, to) => to.hostname === "release-assets.githubusercontent.com",
  );
  check(raw.length === ASSET_BYTES && digest(raw) === ASSET_SHA, "Pinned release integrity.");
  const archive = tar(raw, 128 * 1024 * 1024, 128), selected = new Map<string, Buffer<ArrayBuffer>>();
  let total = 0;
  const rows = archive.members.map((member) => {
    const canonical = safe(member.name, member.kind === "directory");
    check(
      member.name.length <= 512 && canonical.split("/")[0] === "age" && member.kind !== "link" &&
        member.size <= 32 * 1024 * 1024,
      "Age TAR member admission.",
    );
    total += member.size;
    check(total <= 120 * 1024 * 1024, "Age declared aggregate ceiling.");
    const row: Record<string, unknown> = {
      path: member.name,
      identity: canonical,
      bytes: member.size,
      mode: member.mode,
      kind: member.kind,
    };
    if (member.kind === "file") {
      row.sha256 = digest(member.data);
      if (["age/age", "age/age-keygen", "age/LICENSE"].includes(member.name)) {
        if (member.name !== "age/LICENSE") {
          const bytes = member.data;
          check(
            (member.mode & 0o111) !== 0 && bytes.length >= 64 &&
              bytes.subarray(0, 7).equals(Buffer.from([127, 69, 76, 70, 2, 1, 1])),
            "Executable ELF64 little-endian profile.",
          );
          check(
            bytes.readUInt16LE(18) === 183 && [2, 3].includes(bytes.readUInt16LE(16)),
            "AArch64 executable/shared ELF profile.",
          );
          row.elf = {
            class: 64,
            byteOrder: "little",
            machine: "AArch64",
            machineId: 183,
            originalExecutableMode: member.mode,
          };
        }
        selected.set(member.name, member.data);
      }
    }
    return row;
  });
  check(selected.has("age/age") && selected.has("age/age-keygen"), "Required native binaries.");
  snapshot(root, "age-v1.3.2-linux-arm64.tar.gz.snapshot", raw);
  for (const [name, bytes] of selected) snapshot(root, "cli/" + name.slice(4) + ".snapshot", bytes);
  return {
    url: ASSET,
    ...identity(raw),
    expandedTarBytes: archive.expandedBytes,
    members: rows,
    selected: [...selected.keys()],
    scope: "Inert only; no archived executable run. License is separately pinned in source stage.",
  };
}
interface SourceType {
  repo: string;
  ref: string;
  path: string;
  bytes: number;
  gitBlob: string;
  expect?: string;
}
function source(value: unknown, repo?: string, ref?: string, expect?: string): SourceType {
  const item = record(value),
    repository = repo ?? text(item.repo),
    revision = ref ?? text(item.ref),
    path = safe(text(item.path));
  check(path.length <= 512 && REVISIONS[repository] === revision, "Unreviewed repository/revision.");
  const blob = text(item.gitBlob);
  check(/^[0-9a-f]{40}$/.test(blob), "Invalid Git blob identity.");
  return {
    repo: repository,
    ref: revision,
    path,
    bytes: integer(item.bytes, 65536),
    gitBlob: blob,
    ...(expect === undefined ? {} : { expect }),
  };
}
/** Z_FINISH rejects truncated input; bytesWritten rejects trailing compressed input. See nodejs.org/api/zlib.html. */
function vector(
  data: Buffer<ArrayBuffer>,
  expected: string,
): { fields: Record<string, string[]>; wire: Buffer<ArrayBufferLike> } {
  const split = data.indexOf(Buffer.from("\n\n"));
  check(split >= 0 && split <= 4096, "Vector metadata framing.");
  const head = data.subarray(0, split);
  check(head.every((byte) => byte <= 127), "Vector metadata must be ASCII.");
  const fields: Record<string, string[]> = {};
  for (const line of head.toString("ascii").split(/\r?\n/)) {
    const colon = line.indexOf(": "), key = line.slice(0, colon);
    check(
      colon > 0 && ["expect", "payload", "identity", "file key", "comment", "compressed"].includes(key),
      "Vector metadata key.",
    );
    (fields[key] ??= []).push(line.slice(colon + 2));
  }
  check(
    fields.expect?.length === 1 && fields.expect[0] === expected,
    "Original vector expectation differs from manifest.",
  );
  check(fields["file key"]?.length === 1 && /^[0-9a-fA-F]{32}$/.test(fields["file key"][0]!), "File key metadata.");
  let wire: Buffer<ArrayBufferLike> = data.subarray(split + 2);
  if (fields.compressed) {
    check(fields.compressed.length === 1 && fields.compressed[0] === "zlib", "Vector compression profile.");
    // The info option is part of Node's synchronous convenience API; the narrow
    // structural result check also keeps older ambient type declarations honest.
    const result: unknown = inflateSync(wire, { maxOutputLength: 1024 * 1024, info: true });
    const decoded = record(result), engine = record(decoded.engine);
    check(
      Buffer.isBuffer(decoded.buffer) && engine.bytesWritten === wire.length,
      "Expanded vector extent or trailing input.",
    );
    wire = decoded.buffer;
  }
  check(wire.length <= 1024 * 1024, "Expanded vector ceiling.");
  return { fields, wire };
}
async function vectors(root: string): Promise<unknown> {
  const admitted = manifest(values.manifest!), sources = manifest(values.sources!);
  check(
    admitted.commit === CCTV && Array.isArray(admitted.vectors) && admitted.vectors.length === 50 &&
      Array.isArray(sources.files) && sources.files.length === 9,
    "Reviewed source/vector inventory.",
  );
  const files: SourceType[] = sources.files.map((item: unknown) => source(item));
  for (const value of admitted.vectors) {
    const item = record(value);
    files.push(source(item, "C2SP/CCTV", CCTV, text(item.expect)), source(item.generator, "C2SP/CCTV", CCTV));
  }
  const seen = new Set<string>(), rows: Record<string, unknown>[] = [];
  let total = 0, expanded = 0;
  for (const item of files) {
    const key = item.repo + "/" + item.path;
    check(!seen.has(key), "Duplicate admitted source.");
    seen.add(key);
    const url = "https://raw.githubusercontent.com/" + item.repo + "/" + item.ref + "/" + item.path;
    const bytes = await fetchBytes(url, item.bytes, deadline);
    check(bytes.length === item.bytes && gitBlob(bytes) === item.gitBlob, "Pinned source extent/Git blob.");
    total += bytes.length;
    check(total <= 512 * 1024, "Aggregate source acquisition ceiling.");
    snapshot(root, "sources/" + key + ".snapshot", bytes);
    const row: Record<string, unknown> = {
      repo: item.repo,
      ref: item.ref,
      path: item.path,
      gitBlob: item.gitBlob,
      ...identity(bytes),
    };
    if (item.expect !== undefined) {
      const decoded = vector(bytes, item.expect);
      expanded += decoded.wire.length;
      check(expanded <= 16 * 1024 * 1024, "Aggregate expanded vector ceiling.");
      row.metadata = decoded.fields;
      row.wire = identity(decoded.wire);
      snapshot(root, "vectors/" + basename(item.path) + ".age.snapshot", decoded.wire);
    }
    rows.push(row);
  }
  return {
    scope: "Inert immutable sources and original vectors; zlib-only derivations labeled. Nothing imported or executed.",
    cctvCommit: CCTV,
    rawBytes: total,
    expandedVectorBytes: expanded,
    files: rows,
  };
}
await output(values.output, async (root) => {
  const result = positionals[0] === "cli" ? await cli(root) : await vectors(root);
  json(root, positionals[0] + "-receipt.json", {
    stage: positionals[0],
    node: process.version,
    architecture: process.arch,
    scope: "Inert acquisition only",
    result,
  });
});
