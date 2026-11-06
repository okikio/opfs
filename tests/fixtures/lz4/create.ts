/** Create LZ4 frame profiles with installed native lz4 and xxhsum programs.
 *
 * The native decoder compares every output byte with authored input. This uses
 * the CLI's native frame engine, not a new independent codec implementation.
 * New xorshift32 input is distinct from the historical Python random sequence;
 * old fixture and native-FFI receipts remain unchanged beside their snapshot.
 * @module
 */
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Buffer } from "node:buffer";
import { command, equal, hash, options, randomBytes } from "../codec.ts";

const args = options(["lz4", "xxhsum", "output"]);
const lz4 = args.lz4 ?? "lz4";
const xxhsum = args.xxhsum ?? "xxhsum";
const destination = args.output;
if (!destination) throw new TypeError("Supply a new --output path");
const producer = command(lz4, ["--version"]).toString().trim();
const hashProducer = command(xxhsum, ["--version"]).toString().trim();
const root = mkdtempSync(join(tmpdir(), "opfs-lz4-"));
try {
  const seed = randomBytes(65536, 0x12345678);
  const bodies: Record<string, Buffer> = {
    linked: Buffer.concat([seed.subarray(0, 65000), seed.subarray(0, 65000), seed.subarray(0, 3001)]),
    literal: seed.subarray(0, 4097),
    small: Buffer.concat([Buffer.from("LZ4 small\0"), Buffer.from([255]), Buffer.from("payload")]),
    empty: Buffer.alloc(0),
    overlap: Buffer.alloc(100000, 65),
    big1: Buffer.alloc(300000, 65),
    big2: Buffer.alloc(1100000, 65),
  };
  const profiles: [string, string[], string][] = [
    ["independent", ["-B4", "-BI", "-BX", "--content-size"], "linked"],
    ["dependent", ["-B4", "-BD", "-BX", "--content-size"], "linked"],
    ["content-only", ["-B4", "-BI"], "small"],
    ["no-checksum", ["-B4", "-BI", "--no-frame-crc"], "small"],
    ["raw", ["-B4", "-BI", "-BX"], "literal"],
    ["empty", ["-B4", "-BI", "-BX", "--content-size"], "empty"],
    ["overlap", ["-B4", "-BI", "-BX", "--content-size"], "overlap"],
    ["block5", ["-B5", "-BI", "-BX", "--content-size"], "linked"],
    ["block6", ["-B6", "-BI", "-BX", "--content-size"], "big1"],
    ["block7", ["-B7", "-BI", "-BX", "--content-size"], "big2"],
  ];
  const frames: Record<string, { body: string; archive: string; sha256: string }> = {};
  for (const [name, flags, bodyName] of profiles) {
    const body = bodies[bodyName];
    if (!body) throw new Error("Unknown authored LZ4 body");
    const input = join(root, name + ".bin");
    const output = join(root, name + ".lz4");
    writeFileSync(input, body, { flag: "wx" });
    command(lz4, ["-f", ...flags, input, output]);
    if (statSync(output).size > 16 * 1024 * 1024) throw new RangeError("Native LZ4 frame exceeds 16 MiB admission");
    const archive = readFileSync(output);
    equal(command(lz4, ["-d", "-c", output]), body, name);
    frames[name] = { body: body.toString("base64"), archive: archive.toString("base64"), sha256: hash(archive) };
  }
  const hashes = [];
  for (const size of [0, 1, 3, 4, 7, 15, 16, 17, 31, 32, 33, 255, 4097]) {
    const body = Buffer.from(Array.from({ length: size }, (_, at) => (at * 31 + 17) % 251));
    const path = join(root, "hash.bin");
    writeFileSync(path, body);
    const xxh32 = command(xxhsum, ["-H0", path]).toString().split(/\s+/u)[0];
    if (!xxh32 || !/^[a-f\d]{8}$/iu.test(xxh32)) throw new Error("Native xxhsum output is not an XXH32 digest");
    hashes.push({ body: body.toString("base64"), xxh32 });
  }
  const controls: Record<string, string> = {};
  /** Header controls are authored mutations with a native checksum, not producer acceptance claims. */
  const header = (name: string, descriptor: Uint8Array, body: Uint8Array): void => {
    const path = join(root, "header.bin");
    writeFileSync(path, descriptor);
    const token = command(xxhsum, ["-H0", path]).toString().split(/\s+/u)[0];
    if (!token || !/^[a-f\d]{8}$/iu.test(token)) throw new Error("Native descriptor checksum is missing");
    controls[name] = Buffer.concat([
      Buffer.from([4, 34, 77, 24]),
      descriptor,
      Buffer.from([(parseInt(token, 16) >>> 8) & 255]),
      body,
    ]).toString("base64");
  };
  const plainFrame = frames["no-checksum"];
  const sizedFrame = frames.independent;
  if (!plainFrame || !sizedFrame) throw new Error("Required LZ4 control base is missing");
  const plain = Buffer.from(plainFrame.archive, "base64");
  const sized = Buffer.from(sizedFrame.archive, "base64");
  const flag = plain[4];
  const block = plain[5];
  if (flag === undefined || block === undefined) throw new Error("Native frame header is truncated");
  header("dictionary-zero", Buffer.from([flag | 1, block, 0, 0, 0, 0]), plain.subarray(7));
  const unsafe = Buffer.alloc(8);
  unsafe.writeBigUInt64LE(2n ** 53n);
  const mismatch = Buffer.alloc(8);
  mismatch.writeBigUInt64LE(BigInt(bodies.linked!.length + 1));
  header("unsafe-size", Buffer.concat([sized.subarray(4, 6), unsafe]), sized.subarray(15));
  header("size-mismatch", Buffer.concat([sized.subarray(4, 6), mismatch]), sized.subarray(15));
  writeFileSync(
    destination,
    JSON.stringify(
      {
        producer,
        consumer: "native lz4 CLI decoder; same frame engine",
        hashProducer,
        source:
          "authored TypeScript xorshift32 originals and framing controls; not the historical Python/FFI execution",
        frames,
        hashes,
        controls,
      },
      null,
      2,
    ) + "\n",
    { flag: "wx" },
  );
} finally {
  rmSync(root, { recursive: true, force: true });
}
