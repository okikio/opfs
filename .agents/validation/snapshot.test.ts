import { describe, it } from "node:test";
import { expect } from "@std/expect";
import { createHash } from "node:crypto";
import { appendFile, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { preflight, restore, retain, retire, verify } from "./snapshot.ts";

/** Keep the fixture tool independent of inherited credentials and Node spawn environment discovery. */
function tar(args: string[]): Buffer {
  const result = new Deno.Command("/usr/bin/tar", {
    args,
    clearEnv: true,
    stdout: "piped",
    stderr: "piped",
  }).outputSync();
  // new TextDecoder().decode(result.stderr).
  expect(result.code).toBe(0);
  return Buffer.from(result.stdout);
}

const unlimitedDisk = { reserveBytes: 0 };
const digest = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

/** Each case owns a fresh real filesystem; no project sources or receipts are inputs. */
async function workspace(run: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "opfs-retention-test-"));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

/** Native tar supplies independent headers/padding; later input growth shifts unchanged file offsets. */
async function archive(
  root: string,
  version = 1,
  keptBytes = 128 * 1024,
): Promise<{ path: string; bytes: Buffer }> {
  const source = join(root, "source");
  await mkdir(source, { recursive: true });
  await writeFile(
    join(source, "changing.txt"),
    Buffer.alloc(version === 1 ? 600 : 1900, version),
  );
  // These are deliberately source-only files, including work absent from any Git commit.
  await writeFile(
    join(source, "paused-uncommitted.ts"),
    "export const pausedExpansion = 'recover me';\n",
  );
  const kept = Buffer.alloc(keptBytes);
  for (let i = 0; i < kept.length; i++) kept[i] = i % 251;
  await writeFile(join(source, "kept.bin"), kept);
  const path = join(root, `source-${version}.tar`);
  tar([
    "-cf",
    path,
    "-C",
    source,
    "changing.txt",
    "paused-uncommitted.ts",
    "kept.bin",
  ]);
  // A valid extra zero trailer must survive reconstruction as well as file contents.
  await appendFile(path, Buffer.alloc(1024));
  return { path, bytes: await readFile(path) };
}

async function objects(store: string): Promise<string[]> {
  try {
    const paths = (await readdir(join(store, "objects"))).filter((name) => name.endsWith(".gz")).sort();
    for (const name of paths) {
      const bytes = await readFile(join(store, "objects", name));
      // objects must be actual gzip streams.
      expect([...bytes.subarray(0, 2)]).toEqual([0x1f, 0x8b]);
      gunzipSync(bytes);
    }
    return paths;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

async function manifests(store: string): Promise<string[]> {
  try {
    return (await readdir(join(store, "manifests"))).filter((name) => name.endsWith(".json")).sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

describe("lossless source snapshot retention", () => {
  it("restores a file spanning multiple bounded gzip objects without losing its last partial block", async () => {
    await workspace(async (root) => {
      const original = await archive(root, 1, 5 * 1024 * 1024 + 17);
      const kept = await retain(
        original.path,
        join(root, "store"),
        unlimitedDisk,
      );
      const output = join(root, "large-restored.tar");
      await restore(kept.manifest, output);
      expect((await readFile(output)).equals(original.bytes)).toBe(true);
      expect(await verify(kept.manifest)).toEqual({
        sha256: digest(original.bytes),
        bytes: original.bytes.length,
      });
    });
  });
  it("restores exact native tar bytes, including paused source and the original trailer", async () => {
    await workspace(async (root) => {
      const original = await archive(root);
      const store = join(root, "store");
      const kept = await retain(original.path, store, unlimitedDisk);
      expect(kept.sha256).toBe(digest(original.bytes));
      expect(kept.bytes).toBe(original.bytes.length);
      expect(await verify(kept.manifest)).toEqual({
        sha256: digest(original.bytes),
        bytes: original.bytes.length,
      });
      // retaining must not retire the raw source.
      expect((await readFile(original.path)).equals(original.bytes)).toBe(true);
      expect(original.bytes.includes(Buffer.from("recover me"))).toBeTruthy();
      const output = join(root, "restored.tar");
      await restore(kept.manifest, output);
      expect((await readFile(output)).equals(original.bytes)).toBe(true);
      const listing = tar(["-tf", output]).toString("utf8");
      expect(listing).toMatch(/paused-uncommitted\.ts/);
      const source = tar(["-xOf", output, "paused-uncommitted.ts"]).toString(
        "utf8",
      );
      expect(source).toBe("export const pausedExpansion = 'recover me';\n");
    });
  });

  it("shares unchanged gzip objects between versions despite shifted tar offsets", async () => {
    await workspace(async (root) => {
      const first = await archive(root, 1);
      const store = join(root, "store");
      const a = await retain(first.path, store, unlimitedDisk);
      const before = await objects(store);
      expect(before.length > 0).toBeTruthy();
      const second = await archive(root, 2);
      expect(first.bytes.indexOf(Buffer.from("recover me"))).not.toBe(
        second.bytes.indexOf(Buffer.from("recover me")),
      );
      const b = await retain(second.path, store, unlimitedDisk);
      expect(a.sha256).not.toBe(b.sha256);
      const after = await objects(store);
      expect(before.every((name) => after.includes(name))).toBeTruthy();
      const added = after.filter((name) => !before.includes(name));
      expect(added.length > 0).toBeTruthy();
      expect(added.length < before.length).toBeTruthy();
      for (
        const [snapshot, expected, name] of [[a, first.bytes, "first"], [
          b,
          second.bytes,
          "second",
        ]] as const
      ) {
        const output = join(root, `${name}-restore.tar`);
        await restore(snapshot.manifest, output);
        expect((await readFile(output)).equals(expected)).toBe(true);
      }
    });
  });

  it("repeated retention returns the same manifest without growing the object store", async () => {
    await workspace(async (root) => {
      const original = await archive(root);
      const store = join(root, "store");
      const first = await retain(original.path, store, unlimitedDisk);
      const inventory = await objects(store);
      const second = await retain(original.path, store, unlimitedDisk);
      expect(second).toEqual(first);
      expect(await objects(store)).toEqual(inventory);
      expect((await manifests(store)).length).toBe(1);
    });
  });

  it("retires a raw archive only after a recoverable snapshot is verified", async () => {
    await workspace(async (root) => {
      const original = await archive(root);
      const kept = await retain(
        original.path,
        join(root, "store"),
        unlimitedDisk,
      );
      await retire(original.path, kept.manifest);
      await expect(stat(original.path)).rejects.toMatchObject({
        code: "ENOENT",
      });
      const restored = join(root, "after-retirement.tar");
      await restore(kept.manifest, restored);
      expect((await readFile(restored)).equals(original.bytes)).toBe(true);
    });
  });

  it("corrupted retained objects block verification and retirement, preserving the raw archive", async () => {
    await workspace(async (root) => {
      const original = await archive(root);
      const store = join(root, "store");
      const kept = await retain(original.path, store, unlimitedDisk);
      const [object] = await objects(store);
      if (object === undefined) throw new Error("Expected one retained object.");
      await writeFile(
        join(store, "objects", object),
        Buffer.from("damaged gzip object"),
      );
      await expect(verify(kept.manifest)).rejects.toThrow();
      await expect(retire(original.path, kept.manifest)).rejects.toThrow();
      expect((await readFile(original.path)).equals(original.bytes)).toBe(true);
    });
  });

  it("a changed raw archive cannot be retired using an older manifest", async () => {
    await workspace(async (root) => {
      const original = await archive(root);
      const kept = await retain(
        original.path,
        join(root, "store"),
        unlimitedDisk,
      );
      const changed = Buffer.concat([original.bytes, Buffer.alloc(512)]);
      await writeFile(original.path, changed);
      await expect(retire(original.path, kept.manifest)).rejects.toThrow();
      expect((await readFile(original.path)).equals(changed)).toBe(true);
      await verify(kept.manifest);
    });
  });

  it("refuses corrupt headers and truncated payloads without publishing a manifest", async () => {
    await workspace(async (root) => {
      const original = await archive(root);
      const corrupt = Buffer.from(original.bytes);
      corrupt.writeUInt8(corrupt.readUInt8(0) ^ 0x20, 0); // Change a header byte without updating its native checksum.
      const candidates = [corrupt, original.bytes.subarray(0, 700)];
      for (const [i, candidate] of candidates.entries()) {
        const source = join(root, `invalid-${i}.tar`);
        const store = join(root, `invalid-store-${i}`);
        await writeFile(source, candidate);
        await expect(retain(source, store, unlimitedDisk)).rejects.toThrow();
        expect(await manifests(store)).toEqual([]);
        expect((await readFile(source)).equals(candidate)).toBe(true);
      }
    });
  });

  it("an impossible disk reserve refuses admission before source retirement", async () => {
    await workspace(async (root) => {
      const original = await archive(root);
      const store = join(root, "store");
      await expect(
        preflight(store, original.bytes.length, {
          reserveBytes: Number.MAX_SAFE_INTEGER,
        }),
      ).rejects.toThrow();
      await expect(
        retain(original.path, store, { reserveBytes: Number.MAX_SAFE_INTEGER }),
      ).rejects.toThrow();
      expect((await readFile(original.path)).equals(original.bytes)).toBe(true);
      expect(await manifests(store)).toEqual([]);
    });
  });

  it("a tiny store quota blocks new objects and keeps the original archive intact", async () => {
    await workspace(async (root) => {
      const original = await archive(root);
      const store = join(root, "store");
      await expect(
        retain(original.path, store, { reserveBytes: 0, maxBytes: 1 }),
      ).rejects.toThrow();
      expect((await readFile(original.path)).equals(original.bytes)).toBe(true);
      expect(await manifests(store)).toEqual([]);
    });
  });

  it("restore refuses an existing destination without overwriting its bytes", async () => {
    await workspace(async (root) => {
      const original = await archive(root);
      const kept = await retain(
        original.path,
        join(root, "store"),
        unlimitedDisk,
      );
      const output = join(root, "occupied.tar");
      const sentinel = Buffer.from("another caller owns these bytes");
      await writeFile(output, sentinel);
      await expect(restore(kept.manifest, output)).rejects.toThrow();
      expect((await readFile(output)).equals(sentinel)).toBe(true);
      await verify(kept.manifest);
    });
  });

  it("a concurrent writer lock is refused and remains owned by that writer", async () => {
    await workspace(async (root) => {
      const original = await archive(root);
      const store = join(root, "store");
      await mkdir(store);
      const lock = join(store, ".lock");
      await writeFile(lock, "other writer\n", { flag: "wx" });
      await expect(retain(original.path, store, unlimitedDisk)).rejects
        .toThrow();
      expect(await readFile(lock, "utf8")).toBe("other writer\n");
      expect(await manifests(store)).toEqual([]);
      expect((await readFile(original.path)).equals(original.bytes)).toBe(true);
    });
  });

  it("missing or non-file sources fail without publishing a snapshot", async () => {
    await workspace(async (root) => {
      const store = join(root, "store");
      await expect(retain(join(root, "missing.tar"), store, unlimitedDisk))
        .rejects.toThrow();
      await expect(retain(root, store, unlimitedDisk)).rejects.toThrow();
      expect(await manifests(store)).toEqual([]);
    });
  });
});
