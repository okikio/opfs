/** Agent-owned exact-tar retention. Never imports or executes candidate source. */
import { createHash, randomUUID } from "node:crypto";
import { link, lstat, mkdir, open, readdir, readFile, statfs, unlink } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { z } from "zod";

/** Host policy in bytes, independent of container heap/evidence. No age-based pruning. */
export interface Policy {
  readonly reserveBytes?: number;
  readonly maxBytes?: number;
}
/** Keep disk for other work and bound unique retained growth; exhaustion stops new runs. */
export const defaults = {
  reserveBytes: 5 * 1024 ** 3,
  maxBytes: 512 * 1024 ** 2,
} as const;
const partBytes = 4 * 1024 ** 2;
// Bound manifest construction even when repeated zero-filled records cost almost no new storage.
const maxParts = 131072;
const digestSchema = z.string().regex(/^[a-f0-9]{64}$/u);
/** Ordered exact segments; historical filenames are never interpreted or extracted. */
const SnapshotSchema = z.strictObject({
  version: z.literal(1),
  sha256: digestSchema,
  bytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  parts: z.array(digestSchema).nonempty().max(maxParts),
});
type SnapshotType = z.output<typeof SnapshotSchema>;
/** Published only after complete reconstruction and hash verification. */
export interface Retained {
  readonly manifest: string;
  readonly sha256: string;
  readonly bytes: number;
}
function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
function policy(options: Policy): Required<Policy> {
  const limits = { ...defaults, ...options };
  for (const value of [limits.reserveBytes, limits.maxBytes]) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new RangeError(
        "Snapshot policy requires nonnegative safe integer bytes",
      );
    }
  }
  if (!limits.maxBytes) {
    throw new RangeError("Snapshot store quota must be positive");
  }
  return limits;
}
/** Count only private regular objects; refuse unexpected symlinks/special files. */
async function usage(path: string): Promise<number> {
  let bytes = 0;
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) bytes += await usage(child);
    else if (entry.isFile()) bytes += (await lstat(child)).size;
    else throw new Error("Snapshot store contains a non-file entry: " + child);
  }
  return bytes;
}
async function space(
  path: string,
  required: number,
  reserve: number,
): Promise<void> {
  if (!Number.isSafeInteger(required) || required < 0) {
    throw new RangeError("Invalid snapshot disk estimate");
  }
  const disk = await statfs(path);
  const available = disk.bavail * disk.bsize;
  if (required > available || reserve > available - required) {
    throw new Error(
      `Snapshot disk reserve refused: ${available} available, ${required} required, ${reserve} reserved bytes`,
    );
  }
}
/** Admit before making a raw tar. The caller must estimate evidence separately too. */
export async function preflight(
  store: string,
  requiredBytes: number,
  options: Policy = {},
): Promise<void> {
  const limits = policy(options);
  await mkdir(store, { recursive: true });
  await space(store, requiredBytes, limits.reserveBytes);
  if (await usage(store) >= limits.maxBytes) {
    throw new Error(
      "Snapshot store quota reached; preserve/export states before raising it",
    );
  }
}
async function syncDirectory(path: string): Promise<void> {
  const directory = await open(path, "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}
/** Publish a synced sibling without replacing another immutable object. */
async function publish(path: string, bytes: Uint8Array): Promise<void> {
  const temporary = path + ".pending-" + randomUUID();
  const file = await open(temporary, "wx", 0o600);
  try {
    try {
      await file.writeFile(bytes);
      await file.sync();
    } finally {
      await file.close();
    }
    await link(temporary, path);
  } finally {
    await unlink(temporary);
  }
}
async function object(store: string, hash: string): Promise<Buffer> {
  const path = join(store, "objects", hash + ".gz");
  const info = await lstat(path);
  if (!info.isFile() || info.size > partBytes + 65536) {
    throw new Error("Invalid retained object: " + hash);
  }
  const bytes = gunzipSync(await readFile(path), {
    maxOutputLength: partBytes,
  });
  if (!bytes.length || digest(bytes) !== hash) {
    throw new Error("Retained object SHA-256 mismatch: " + hash);
  }
  return bytes;
}
async function load(
  path: string,
): Promise<{ snapshot: SnapshotType; store: string }> {
  const info = await lstat(path);
  if (!info.isFile() || info.size > 32 * 1024 ** 2) {
    throw new Error("Invalid snapshot manifest file");
  }
  const snapshot = SnapshotSchema.parse(
    JSON.parse(await readFile(path, "utf8")),
  );
  return { snapshot, store: resolve(dirname(path), "..") };
}
/** Reconstruct every retained byte; successful decoding alone is insufficient. */
export async function verify(
  manifest: string,
): Promise<{ sha256: string; bytes: number }> {
  const { snapshot, store } = await load(manifest);
  const hash = createHash("sha256");
  let bytes = 0;
  for (const key of snapshot.parts) {
    const chunk = await object(store, key);
    hash.update(chunk);
    bytes += chunk.length;
    if (bytes > snapshot.bytes) {
      throw new Error("Snapshot exceeds recorded byte count");
    }
  }
  if (bytes !== snapshot.bytes || hash.digest("hex") !== snapshot.sha256) {
    throw new Error("Snapshot reconstruction hash/size mismatch");
  }
  return { sha256: snapshot.sha256, bytes };
}
async function read(file: FileHandle, length: number): Promise<Buffer> {
  const buffer = Buffer.alloc(length);
  let offset = 0;
  while (offset < length) {
    const got = await file.read(buffer, offset, length - offset, null);
    if (!got.bytesRead) throw new Error("Truncated source tar");
    offset += got.bytesRead;
  }
  return buffer;
}
/** Frame native tar records only; no source path, payload or executable is evaluated. */
function size(header: Buffer): number {
  const octal = (start: number, end: number): number => {
    const value = header.subarray(start, end).toString("ascii").replace(
      /\0/gu,
      " ",
    ).trim();
    if (!/^[0-7]+$/u.test(value)) {
      throw new Error("Unsupported source tar numeric header");
    }
    const number = Number.parseInt(value, 8);
    if (!Number.isSafeInteger(number)) {
      throw new Error("Unsafe source tar size");
    }
    return number;
  };
  let sum = 0;
  for (let i = 0; i < header.length; i++) {
    sum += i >= 148 && i < 156 ? 32 : header[i]!;
  }
  if (sum !== octal(148, 156)) {
    throw new Error("Source tar header checksum mismatch");
  }
  return octal(124, 136);
}
/** Share headers and bounded payload segments across versions, even with shifted offsets.
 * Failed captures keep their raw tar and admitted objects. One writer accounts quota.
 * A crash-left lock blocks instead of guessing whether another writer is alive.
 */
export async function retain(
  archive: string,
  store: string,
  options: Policy = {},
): Promise<Retained> {
  const limits = policy(options);
  const original = await lstat(archive);
  if (!original.isFile() || original.size < 1024 || original.size % 512) {
    throw new Error("Source must be a complete regular tar file");
  }
  await preflight(store, 0, options);
  const lockPath = join(store, ".lock");
  const lock = await open(lockPath, "wx", 0o600);
  try {
    await lock.writeFile(
      JSON.stringify({ pid: process.pid, started: new Date().toISOString() }) +
        "\n",
    );
    await lock.sync();
    await mkdir(join(store, "objects"), { recursive: true });
    await mkdir(join(store, "manifests"), { recursive: true });
    let used = await usage(store);
    const parts: string[] = [];
    const hash = createHash("sha256");
    let total = 0;
    const append = async (chunk: Buffer): Promise<void> => {
      if (parts.length >= maxParts) {
        throw new Error(
          "Snapshot manifest part limit exceeded; raw tar retained",
        );
      }
      const key = digest(chunk);
      try {
        await object(store, key);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        const compressed = gzipSync(chunk);
        if (used + compressed.length > limits.maxBytes) {
          throw new Error(
            "Snapshot store quota would be exceeded; raw tar retained",
          );
        }
        await space(store, compressed.length, limits.reserveBytes);
        await publish(join(store, "objects", key + ".gz"), compressed);
        used += compressed.length;
        await object(store, key);
      }
      parts.push(key);
      hash.update(chunk);
      total += chunk.length;
    };
    const file = await open(archive, "r");
    let ended = false;
    try {
      while (total < original.size) {
        const header = await read(file, 512);
        if (header.every((byte) => byte === 0)) {
          await append(header);
          if (original.size - total < 512) {
            throw new Error("Source tar lacks its second end block");
          }
          const second = await read(file, 512);
          if (second.some((byte) => byte !== 0)) {
            throw new Error("Invalid source tar end blocks");
          }
          await append(second);
          while (total < original.size) {
            await append(
              await read(file, Math.min(partBytes, original.size - total)),
            );
          }
          ended = true;
          break;
        }
        const payload = Math.ceil(size(header) / 512) * 512;
        if (payload > original.size - total - 512) {
          throw new Error("Truncated source tar payload");
        }
        await append(header);
        let remaining = payload;
        while (remaining) {
          const amount = Math.min(partBytes, remaining);
          await append(await read(file, amount));
          remaining -= amount;
        }
      }
    } finally {
      await file.close();
    }
    if (!ended) throw new Error("Source tar has no end blocks");
    const now = await lstat(archive);
    if (
      now.ino !== original.ino || now.size !== original.size ||
      now.mtimeMs !== original.mtimeMs
    ) throw new Error("Source tar changed during capture");
    const snapshot = SnapshotSchema.parse({
      version: 1,
      sha256: hash.digest("hex"),
      bytes: total,
      parts,
    });
    const manifest = join(store, "manifests", snapshot.sha256 + ".json");
    await syncDirectory(join(store, "objects"));
    try {
      const existing = await load(manifest);
      if (JSON.stringify(existing.snapshot) !== JSON.stringify(snapshot)) {
        throw new Error("Existing manifest disagrees with captured bytes");
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const content = Buffer.from(JSON.stringify(snapshot) + "\n");
      if (used + content.length > limits.maxBytes) {
        throw new Error(
          "Snapshot manifest exceeds store quota; raw tar retained",
        );
      }
      await space(store, content.length * 2, limits.reserveBytes);
      const candidate = manifest + ".verify-" + randomUUID();
      const temporary = await open(candidate, "wx", 0o600);
      try {
        await temporary.writeFile(content);
        await temporary.sync();
      } finally {
        await temporary.close();
      }
      try {
        await verify(candidate);
        await publish(manifest, content);
      } finally {
        await unlink(candidate);
      }
    }
    await syncDirectory(join(store, "manifests"));
    await syncDirectory(store);
    await syncDirectory(dirname(store));
    await verify(manifest);
    return { manifest, sha256: snapshot.sha256, bytes: snapshot.bytes };
  } finally {
    await lock.close();
    await unlink(lockPath);
  }
}
/** Refuse an existing output; failure removes only this call's partial file. */
export async function restore(manifest: string, output: string): Promise<void> {
  const { snapshot, store } = await load(manifest);
  const file = await open(output, "wx", 0o600);
  const identity = await file.stat();
  let complete = false;
  try {
    const hash = createHash("sha256");
    let bytes = 0;
    for (const key of snapshot.parts) {
      const chunk = await object(store, key);
      bytes += chunk.length;
      if (bytes > snapshot.bytes) {
        throw new Error("Snapshot exceeds recorded byte count");
      }
      hash.update(chunk);
      await file.writeFile(chunk);
    }
    if (bytes !== snapshot.bytes || hash.digest("hex") !== snapshot.sha256) {
      throw new Error("Restored snapshot hash mismatch");
    }
    await file.sync();
    complete = true;
  } finally {
    await file.close();
    if (!complete && (await lstat(output)).ino === identity.ino) {
      await unlink(output);
    }
  }
}
/** Only for the controller's immutable UUID-run path, which it owns exclusively.
 * Verify both retained and raw bytes and guard path identity before retiring it.
 */
export async function retire(archive: string, manifest: string): Promise<void> {
  const kept = await verify(manifest);
  const before = await lstat(archive);
  if (!before.isFile()) throw new Error("Raw snapshot is not a regular file");
  const hash = createHash("sha256");
  const file = await open(archive, "r");
  try {
    for await (const chunk of file.createReadStream({ autoClose: false })) {
      hash.update(chunk);
    }
  } finally {
    await file.close();
  }
  const after = await lstat(archive);
  if (
    hash.digest("hex") !== kept.sha256 || before.size !== kept.bytes ||
    after.ino !== before.ino || after.size !== before.size ||
    after.mtimeMs !== before.mtimeMs
  ) throw new Error("Raw snapshot differs from retained state; keep it");
  await unlink(archive);
  await syncDirectory(dirname(archive));
}

// Task entrypoint only. Importing this module acquires no files or other resources.
if (import.meta.main) {
  const [action, manifest, output, ...extra] = process.argv.slice(2);
  if (
    !manifest || extra.length ||
    (action === "verify" ? output !== undefined : action !== "restore" || !output)
  ) {
    throw new Error(
      "Use snapshot:verify <manifest> or snapshot:restore <manifest> <new-output.tar>",
    );
  }
  if (action === "verify") console.log(JSON.stringify(await verify(manifest)));
  else {
    await restore(manifest, output!);
    console.log(
      JSON.stringify({ restored: output, ...await verify(manifest) }),
    );
  }
}
