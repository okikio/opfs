/** Native ZIP codec fixtures plus explicitly authored descriptor framing; no candidate parser or codec imports. */
import { Buffer } from "node:buffer";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { command, encoded, equal, observe, options, producer, publish } from "./codec.ts";

interface MemberType {
  readonly name: string;
  readonly method: number;
  readonly flags: number;
  readonly offset: number;
  readonly compressedSize: number;
  readonly crc32: number;
  readonly local: number;
  readonly central: number;
  readonly centralEnd: number;
}

/** Inspect only ZIP32 records from the selected native producer, refusing other layouts rather than guessing. */
function members(raw: Buffer): readonly MemberType[] {
  const end = raw.length - 22;
  if (end < 0 || raw.readUInt32LE(end) !== 0x06054b50 || raw.readUInt16LE(end + 20) !== 0) {
    throw new Error("Expected comment-free native ZIP32.");
  }
  const count = raw.readUInt16LE(end + 10), directory = raw.readUInt32LE(end + 16);
  if (
    raw.readUInt16LE(end + 4) !== 0 || raw.readUInt16LE(end + 6) !== 0 || count === 0xffff || directory === 0xffffffff
  ) throw new Error("Unsupported native ZIP layout.");
  const result: MemberType[] = [];
  let at = directory;
  for (let index = 0; index < count; index++) {
    if (raw.readUInt32LE(at) !== 0x02014b50) throw new Error("Native central header missing.");
    const flags = raw.readUInt16LE(at + 8), method = raw.readUInt16LE(at + 10), size = raw.readUInt32LE(at + 20);
    const local = raw.readUInt32LE(at + 42), nameBytes = raw.readUInt16LE(at + 28);
    const centralEnd = at + 46 + nameBytes + raw.readUInt16LE(at + 30) + raw.readUInt16LE(at + 32);
    if (
      flags & 1 || size === 0xffffffff || local === 0xffffffff || centralEnd > end ||
      raw.readUInt32LE(local) !== 0x04034b50
    ) throw new Error("Native entry exceeds supported fixture profile.");
    const name = raw.subarray(at + 46, at + 46 + nameBytes).toString("utf8");
    const offset = local + 30 + raw.readUInt16LE(local + 26) + raw.readUInt16LE(local + 28);
    if (offset + size > directory) throw new Error("Native compressed extent overlaps directory.");
    result.push({
      name,
      method,
      flags,
      offset,
      compressedSize: size,
      crc32: raw.readUInt32LE(at + 16),
      local,
      central: at,
      centralEnd,
    });
    at = centralEnd;
  }
  if (at !== end) throw new Error("Unexpected native central-directory trailer.");
  return result;
}

/** Preserve native compressed payloads while authoring explicit bit-3 descriptor records and updated offsets. */
function descriptors(raw: Buffer): Buffer<ArrayBuffer> {
  const local: Buffer[] = [], directory: Buffer[] = [];
  let offset = 0;
  for (const entry of members(raw)) {
    if (entry.flags & 8) throw new Error("Expected seekable native input before descriptor adaptation.");
    const header = Buffer.from(raw.subarray(entry.local, entry.offset));
    header.writeUInt16LE(entry.flags | 8, 6);
    header.fill(0, 14, 26);
    const body = raw.subarray(entry.offset, entry.offset + entry.compressedSize);
    const descriptor = Buffer.alloc(16);
    descriptor.writeUInt32LE(0x08074b50, 0);
    descriptor.writeUInt32LE(entry.crc32, 4);
    descriptor.writeUInt32LE(entry.compressedSize, 8);
    descriptor.writeUInt32LE(raw.readUInt32LE(entry.central + 24), 12);
    const central = Buffer.from(raw.subarray(entry.central, entry.centralEnd));
    central.writeUInt16LE(entry.flags | 8, 8);
    central.writeUInt32LE(offset, 42);
    local.push(header, body, descriptor);
    directory.push(central);
    offset += header.length + body.length + descriptor.length;
  }
  const encodedDirectory = Buffer.concat(directory), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(directory.length, 8);
  end.writeUInt16LE(directory.length, 10);
  end.writeUInt32LE(encodedDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, encodedDirectory, end]);
}

/** Method-specific wrappers share native acquisition and full-byte reciprocal validation without importing OPFS. */
export function createZipFixtures(method: 12 | 14, sourceURL: string): void {
  const args = options(["output", "seven", "bsdtar"]);
  const seven = args.seven ?? "7zz", bsdtar = args.bsdtar ?? "bsdtar";
  const bodies: Readonly<Record<string, Buffer>> = {
    "empty.bin": Buffer.alloc(0),
    "odd.bin": Buffer.from("odd\0\xffbinary\r\n", "latin1"),
    "repeat.bin": Buffer.alloc(80003, 65),
    "many.bin": Buffer.from(
      Array.from({ length: 230017 }, (_, index) => (index * 31 + Math.floor(index / 251) + 17) % 251),
    ),
  };
  const root = mkdtempSync(join(tmpdir(), "opfs-zip-codec-ts-"));
  const fixtures: unknown[] = [];
  try {
    for (const [name, body] of Object.entries(bodies)) writeFileSync(join(root, name), body);
    const profiles = method === 12
      ? [{ name: "seven-1", flags: ["-mm=BZip2", "-mx=1"] }, { name: "seven-9", flags: ["-mm=BZip2", "-mx=9"] }]
      : [{ name: "seven-64k", flags: ["-mm=LZMA", "-md=64k"] }, { name: "seven-1m", flags: ["-mm=LZMA", "-md=1m"] }];
    for (const profile of profiles) {
      const nativePath = join(root, profile.name + ".zip");
      command(seven, ["a", "-tzip", ...profile.flags, nativePath, ...Object.keys(bodies)], undefined, root);
      const native = readFileSync(nativePath);
      for (const adapted of [false, true]) {
        const raw = adapted ? descriptors(native) : native;
        const path = join(root, profile.name + (adapted ? "-descriptor" : "") + ".zip");
        writeFileSync(path, raw);
        const entries = members(raw), names = entries.map((entry) => entry.name).sort();
        if (JSON.stringify(names) !== JSON.stringify(Object.keys(bodies).sort())) {
          throw new Error("Unexpected native member inventory.");
        }
        const records = [];
        for (const entry of entries) {
          const original = bodies[entry.name]!;
          if (![0, method].includes(entry.method)) throw new Error("Native producer selected another codec.");
          equal(command(seven, ["e", "-so", path, entry.name]), original, entry.name + " 7-Zip");
          const archive = observe(bsdtar, ["-xOf", path, entry.name]);
          const emptyRefusal = original.length === 0 && entry.method === 14 && archive.exitCode === 1 &&
            archive.stdout.length === 0 && archive.stderr.toString().includes("lzma unknown error 10");
          if (!emptyRefusal) {
            if (archive.exitCode !== 0) throw new Error("libarchive rejected member: " + archive.stderr.toString());
            equal(archive.stdout, original, entry.name + " libarchive");
          }
          if (adapted && !(entry.flags & 8)) throw new Error("Descriptor adaptation lost bit3.");
          let wire: Record<string, unknown> | null = null;
          if (entry.method === 12 && raw.subarray(entry.offset, entry.offset + 3).toString() !== "BZh") {
            throw new Error("Native BZip2 marker missing.");
          }
          if (entry.method === 14) {
            if (!(entry.flags & 2) || raw.readUInt16LE(entry.offset + 2) !== 5) {
              throw new Error("Native LZMA EOS/property profile differs.");
            }
            wire = {
              sdkVersionBytes: [...raw.subarray(entry.offset, entry.offset + 2)],
              propertySize: 5,
              propertyBytesHex: raw.subarray(entry.offset + 4, entry.offset + 9).toString("hex"),
              dictionaryBytes: raw.readUInt32LE(entry.offset + 5),
            };
          }
          records.push({
            ...entry,
            wire,
            original: encoded(original),
            consumers: {
              seven: "full-byte-match",
              libarchive: {
                status: emptyRefusal ? "empty-lzma-refused" : "full-byte-match",
                exitCode: archive.exitCode,
                stdoutSha256: encoded(archive.stdout).sha256,
                stderr: archive.stderr.toString("utf8"),
              },
            },
          });
        }
        fixtures.push({
          name: profile.name + (adapted ? "-descriptor" : ""),
          origin: adapted
            ? "Authored descriptor framing over genuine native compressed extents"
            : "Genuine native 7-Zip archive",
          archive: encoded(raw),
          members: records,
        });
      }
    }
    publish(args.output!, {
      ...producer(sourceURL),
      zipHarnessSha256: encoded(readFileSync(new URL(import.meta.url))).sha256,
      seven: command(seven, ["i"]).toString("utf8"),
      bsdtar: command(bsdtar, ["--version"]).toString("utf8"),
      scope:
        "New native-only profiles; historical Python and Python-descriptor fixtures remain unchanged and are not recreated or relabelled",
      fixtures,
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
