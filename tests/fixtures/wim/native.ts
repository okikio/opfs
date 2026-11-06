/** Test-only WIM native commands, original inputs and bounded public-API bridge. */
import { deepStrictEqual, equal, ok } from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import process from "node:process";
import { parseArgs } from "node:util";
import { command, read, sha } from "../iso/native.ts";
export { command, read, sha };
export type ChunkType = { packed: string; decoded: string; compressed: boolean; expected: number };
export type ResourceType = {
  flags: number;
  offset: number;
  stored: number;
  decoded: number;
  sha1: string;
  body: string;
  chunks: ChunkType[];
};
export type ImageType = { index: number; name: string; files: { path: string; base64: string; sha1: string }[] };
export type FixtureType = { base64: string; sha256: string; nativeResources: ResourceType[]; images: ImageType[] };
export function digest(bytes: Buffer): string {
  return createHash("sha1").update(bytes).digest("hex");
}
export function save(path: string, value: unknown): void {
  const bytes = JSON.stringify(value, null, 2) + "\n";
  ok(Buffer.byteLength(bytes) <= 32 * 1024 * 1024, "WIM receipt exceeds 32 MiB.");
  writeFileSync(path, bytes, { flag: "wx" });
}
/** Compile against installed reviewed headers; link the native implementation, never candidate code. */
export function bridge(root: string, compiler: string) {
  const source = read(new URL("./bridge.c", import.meta.url), 65536), executable = join(root, "wim-bridge");
  writeFileSync(join(root, "bridge.c"), source, { flag: "wx" });
  const version = command(compiler, ["--version"]).stdout.toString("utf8");
  command(compiler, ["-std=c11", "-O2", join(root, "bridge.c"), "-lwim", "-o", executable]);
  let count = 0;
  const codec = (mode: "compress" | "decompress", type: 1 | 2, input: Buffer, expected: number): Buffer => {
    ok(++count <= 2048 && input.length <= 65536 && expected > 0 && expected <= 32768);
    const path = join(root, "codec-input-" + count);
    writeFileSync(path, input, { flag: "wx" });
    return command(executable, [mode, String(type), String(expected), path]).stdout;
  };
  return {
    codec,
    receipt: {
      compiler: version,
      sourceSha256: sha(source),
      api: "Installed wimlib public compression API; linked native implementation",
    },
  };
}
/** WIM uses 56-bit sizes and safe bounded 64-bit positions in these small controls. */
export function integer(bytes: Buffer, at: number, width: number): number {
  ok(at >= 0 && at + width <= bytes.length && width <= 8);
  let result = 0n;
  for (let index = width - 1; index >= 0; index--) result = result << 8n | BigInt(bytes[at + index] ?? 0);
  ok(result <= BigInt(Number.MAX_SAFE_INTEGER));
  return Number(result);
}
/** Reconstruct every native resource, including metadata, and require its stored SHA1. */
export function resources(data: Buffer, decode: (input: Buffer, expected: number) => Buffer): ResourceType[] {
  ok(data.length >= 208 && ((data[55] ?? 0) & 4) === 0, "Expected a directly stored resource lookup table.");
  const tableSize = integer(data, 48, 7), tableOffset = integer(data, 56, 8);
  ok(tableSize % 50 === 0 && tableSize / 50 <= 256 && tableOffset + tableSize <= data.length);
  const result: ResourceType[] = [];
  for (let at = tableOffset; at < tableOffset + tableSize; at += 50) {
    const size = integer(data, at, 7), flags = data[at + 7];
    ok(flags !== undefined);
    const start = integer(data, at + 8, 8), decoded = integer(data, at + 16, 8);
    ok(start + size <= data.length && decoded <= 2 * 1024 * 1024);
    const raw = data.subarray(start, start + size), chunks: ChunkType[] = [], output: Buffer[] = [];
    if (flags & 4) {
      const count = Math.ceil(decoded / 32768), width = decoded < 2 ** 32 ? 4 : 8, tableLength = (count - 1) * width;
      ok(count > 0 && count <= 64 && tableLength <= size);
      const offsets = [0];
      for (let position = 0; position < tableLength; position += width) offsets.push(integer(raw, position, width));
      offsets.push(size - tableLength);
      for (let index = 0; index < count; index++) {
        const from = offsets[index], to = offsets[index + 1];
        ok(from !== undefined && to !== undefined && from <= to && to <= size - tableLength);
        const packed = raw.subarray(tableLength + from, tableLength + to),
          expected = Math.min(32768, decoded - index * 32768);
        const body = packed.length === expected ? packed : decode(packed, expected);
        equal(body.length, expected);
        chunks.push({
          packed: packed.toString("base64"),
          decoded: body.toString("base64"),
          compressed: packed.length !== expected,
          expected,
        });
        output.push(body);
      }
    } else output.push(raw);
    const body = Buffer.concat(output);
    equal(body.length, decoded);
    const expectedSha1 = data.subarray(at + 30, at + 50).toString("hex");
    equal(digest(body), expectedSha1);
    result.push({
      flags,
      offset: start,
      stored: size,
      decoded,
      sha1: expectedSha1,
      body: body.toString("base64"),
      chunks,
    });
  }
  return result;
}

/** Native apply and independent 7-Zip must both match each complete original file. */
export function verify(archive: string, images: readonly ImageType[], root: string, wim: string, seven: string) {
  const verification = command(wim, ["verify", archive]), consumers = [];
  ok(images.length <= 2);
  for (const image of images) {
    ok((image.index === 1 || image.index === 2) && image.files.length <= 32);
    const destination = join(root, "extracted-" + image.index);
    mkdirSync(destination);
    command(wim, ["apply", archive, String(image.index), destination, "--no-acls"]);
    for (const file of image.files) {
      ok(
        file.path && !file.path.startsWith("/") && !file.path.split("/").some((part) =>
          !part || part === "." || part === ".."
        ) && !file.path.includes("\\"),
      );
      const expected = Buffer.from(file.base64, "base64");
      ok(expected.length <= 2 * 1024 * 1024);
      equal(digest(expected), file.sha1);
      deepStrictEqual(read(join(destination, file.path), 2 * 1024 * 1024), expected);
      const path: string = image.index + "/" + file.path;
      deepStrictEqual(command(seven, ["x", "-so", "-y", archive, path]).stdout, expected);
      consumers.push({ image: image.index, path: file.path, sevenPath: path, exact: true, exitCode: 0 });
    }
  }
  return {
    verification: {
      exitCode: verification.status,
      stdout: verification.stdout.toString("utf8"),
      stderr: verification.stderr.toString("utf8"),
    },
    consumers,
  };
}

/** The fixed original set is admitted from historical authored file receipts, never candidate output. */
export function produce(profile: "none" | "xpress" | "lzx"): void {
  const { values } = parseArgs({
    options: {
      output: { type: "string" },
      wim: { type: "string", default: "wimlib-imagex" },
      seven: { type: "string", default: "7zz" },
      compiler: { type: "string", default: "cc" },
    },
  });
  ok(values.output && values.wim && values.seven && values.compiler, "Supply native tools and a new --output receipt.");
  const filename = profile === "none" ? "independent.json" : profile + "-independent.json",
    originalBytes = read(new URL(filename, import.meta.url));
  const original: FixtureType = JSON.parse(originalBytes.toString("utf8"));
  equal(original.images.length, 2);
  const images = original.images;
  equal(images[0]?.files.length, profile === "none" ? 5 : profile === "xpress" ? 10 : 13);
  equal(images[1]?.files.length, 4);
  const root = mkdtempSync(join(tmpdir(), "opfs-wim-native-")), failures: unknown[] = [];
  try {
    const archive = join(root, "two-images.wim"), capture = [];
    for (const image of images) {
      ok(image.index === 1 || image.index === 2);
      const folder = join(root, String(image.index));
      mkdirSync(folder);
      for (const file of image.files) {
        ok(
          !file.path.startsWith("/") && !file.path.includes("\\") &&
            !file.path.split("/").some((part) => !part || part === "." || part === ".."),
        );
        const value = Buffer.from(file.base64, "base64");
        ok(value.length <= 2 * 1024 * 1024);
        equal(digest(value), file.sha1);
        const target = join(folder, file.path);
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, value, { flag: "wx" });
      }
      const operation = image.index === 1 ? "capture" : "append",
        args = [operation, folder, archive, image.name, "--no-acls"];
      if (image.index === 1) {
        args.push(`--compress=${profile}`);
        if (profile !== "none") args.push("--chunk-size=32768");
      }
      const result = command(values.wim, args);
      capture.push({
        operation,
        exitCode: result.status,
        stdout: result.stdout.toString("utf8"),
        stderr: result.stderr.toString("utf8"),
      });
    }
    const checked = verify(archive, images, root, values.wim, values.seven),
      data = read(archive),
      native = profile === "none" ? undefined : bridge(root, values.compiler);
    const nativeResources = native
      ? resources(data, (input, expected) => native.codec("decompress", profile === "xpress" ? 1 : 2, input, expected))
      : [];
    save(values.output, {
      producer: command(values.wim, ["--version"]).stdout.toString("utf8"),
      consumer: command(values.seven, ["i"]).stdout.toString("utf8"),
      runtime: process.version,
      originalSource:
        "Complete fixed authored payload receipts retained from historical independent fixture; no CPython PRNG emulation",
      originalFixtureSha256: sha(originalBytes),
      base64: data.toString("base64"),
      sha256: sha(data),
      capture,
      verify: checked.verification,
      listing: command(values.seven, ["l", "-slt", archive]).stdout.toString("utf8"),
      consumers: checked.consumers,
      images,
      nativeResources,
      ...(native ? { nativeBridge: native.receipt } : {}),
    });
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
  if (failures.length) throw new AggregateError(failures, "WIM native producer and cleanup failed.");
}
