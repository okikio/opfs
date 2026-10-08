import { describe, it } from "node:test";
import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rename,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, parse } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { platform } from "node:process";
import { expect } from "@std/expect";
import { changes, copy, open, own, pack } from "../.mise/tasks/container.mjs";
import { locate, verify } from "../.mise/tasks/container-worker.mjs";
import { withReleases } from "./close.ts";

/** Windows host modes/link privileges do not prove the mandatory private Linux guard. */
const POSIX = {
  skip: platform === "win32" ? "Host POSIX modes and link privileges are not portable observations." : false,
};

/** Acquires cleanup immediately; owner-writable fixtures never need a chmod traversal. */
async function fixture(action: (root: string) => Promise<void>): Promise<void> {
  await withReleases(async (releases) => {
    const acquired = await own(await mkdtemp(join(tmpdir(), "opfs-input-control-")));
    releases.push(() => acquired.close());
    await action(acquired.directory);
  });
}

describe("container copy admission", () => {
  it("retains an absolute volume-root identity throughout private acquisition and cleanup", async () => {
    await fixture(async (root) => {
      // C: is drive-relative on Windows; it cannot stand in for the observed C:\ root.
      const volume = parse(root).root;
      const canonical = await locate(volume);
      expect(isAbsolute(canonical)).toBe(true);
      expect(dirname(canonical)).toBe(canonical);
      expect(parse(canonical).root).toBe(canonical);
      expect((await lstat(canonical)).isDirectory()).toBe(true);
      const acquired = await own(await mkdtemp(join(root, "volume-control-")));
      await withReleases(async (releases) => {
        releases.push(() => acquired.close());
        expect(acquired.identity.observations.at(-1)?.[0]).toBe(canonical);
        await acquired.verify();
        expect(await locate(volume)).toBe(canonical);
      });
    });
  });
  it("classifies real catalog differences with full digests and finite retained entries", () => {
    const value = { kind: "file", mode: 0o600, links: 1, bytes: 1, sha256: "a" };
    const before = {
      paths: ["original"],
      root: { uid: 1000, gid: 1000, mode: 0o755 },
      entries: Object.fromEntries(Array.from({ length: 40 }, (_, index) => [`deno-cache/${index}`, value])),
    };
    const after = {
      paths: ["new"],
      root: { uid: 1000, gid: 1000, mode: 0o700 },
      entries: {
        ...Object.fromEntries(
          Array.from({ length: 40 }, (_, index) => [`deno-cache/${index}`, { ...value, sha256: "b" }]),
        ),
        "source/mod.ts": value,
        "source/node_modules/a": value,
        "source/node_modules-example.ts": value,
      },
    };
    const result = changes(before, after);
    expect(result.scopes).toEqual({ source: 2, dependencies: 1, cache: 40 });
    expect(result.changedEntries).toBe(43);
    expect(result.differences.length).toBe(32);
    expect(result.omittedDifferences).toBe(11);
    expect(result.sourceMembership).toEqual({ addedCount: 1, removedCount: 1, added: ["new"], removed: ["original"] });
    expect(result.beforeSha256).toBe(createHash("sha256").update(JSON.stringify(before)).digest("hex"));
    expect(result.afterSha256).toBe(createHash("sha256").update(JSON.stringify(after)).digest("hex"));
    expect(result.root).toEqual({ before: before.root, after: after.root });
  });
  it("settles one cached private cleanup without restoring descendant permissions", async () => {
    await fixture(async (root) => {
      const acquired = await own(await mkdtemp(join(root, "private-")));
      await mkdir(join(acquired.directory, "child"));
      await writeFile(join(acquired.directory, "child/bytes"), new Uint8Array([0, 255, 128]));
      const closing = acquired.close();
      expect(acquired.close()).toBe(closing);
      await closing;
      expect(acquired.close()).toBe(closing);
      let failure: unknown;
      try {
        await lstat(acquired.directory);
      } catch (error) {
        failure = error;
      }
      expect(failure).toMatchObject({ code: "ENOENT" });
    });
  });
  it("retains admission failure and refused substituted-root cleanup independently", POSIX, async () => {
    await fixture(async (root) => {
      const repository = join(root, "repository");
      await mkdir(join(repository, "node_modules"), { recursive: true });
      const primary = new Error("controlled admission failure");
      let replaced = "";
      let failure: unknown;
      try {
        await open(repository, {
          temporary: root,
          run: async () => {
            const name = (await readdir(root)).find((value) => value.startsWith("opfs-container-"));
            if (!name) throw new Error("Actual acquired staging directory was not observed.");
            replaced = join(root, name);
            await rename(replaced, join(root, "moved-private"));
            await mkdir(replaced, { mode: 0o755 });
            await writeFile(join(replaced, "sentinel"), "borrowed remains");
            throw primary;
          },
        });
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(AggregateError);
      if (!(failure instanceof AggregateError)) throw new Error("Admission and cleanup did not retain both outcomes.");
      expect(failure.errors.length).toBe(2);
      expect(failure.errors[0]).toBe(primary);
      expect(failure.errors[1]).toBeInstanceOf(Error);
      expect(await readFile(join(replaced, "sentinel"), "utf8")).toBe("borrowed remains");
      expect((await lstat(replaced)).mode & 0o777).toBe(0o755);
    });
  });
  it("refuses a substituted physical root and preserves outside bytes and modes", POSIX, async () => {
    await fixture(async (root) => {
      const directory = await mkdtemp(join(root, "owned-")), moved = join(root, "moved");
      const acquired = await own(directory);
      await rename(directory, moved);
      await mkdir(directory, { mode: 0o755 });
      await writeFile(join(directory, "sentinel"), "borrowed bytes");
      const before = (await lstat(directory)).mode & 0o777;
      const failure = acquired.close();
      await expect(failure).rejects.toThrow();
      expect(acquired.close()).toBe(failure);
      expect(await readFile(join(directory, "sentinel"), "utf8")).toBe("borrowed bytes");
      expect((await lstat(directory)).mode & 0o777).toBe(before);
    });
  });
  it("refuses a replaced parent alias without traversing its outside descendant", POSIX, async () => {
    await fixture(async (root) => {
      const parent = join(root, "parent"), moved = join(root, "old-parent"), outside = join(root, "outside");
      await mkdir(parent);
      const directory = await mkdtemp(join(parent, "owned-"));
      const acquired = await own(directory);
      await mkdir(join(outside, directory.slice(parent.length + 1)), { recursive: true, mode: 0o755 });
      const borrowed = join(outside, directory.slice(parent.length + 1));
      const sentinel = join(borrowed, "sentinel");
      await writeFile(sentinel, "outside remains");
      const before = (await lstat(borrowed)).mode & 0o777;
      await rename(parent, moved);
      await symlink(outside, parent);
      await expect(acquired.close()).rejects.toThrow();
      expect(await readFile(sentinel, "utf8")).toBe("outside remains");
      expect((await lstat(borrowed)).mode & 0o777).toBe(before);
    });
  });
  it("removes an owned descendant alias without acquiring its outside target", POSIX, async () => {
    await fixture(async (root) => {
      const outside = join(root, "outside");
      await mkdir(outside, { mode: 0o755 });
      await writeFile(join(outside, "sentinel"), "outside remains");
      const before = (await lstat(outside)).mode & 0o777;
      const acquired = await own(await mkdtemp(join(root, "owned-")));
      await symlink(outside, join(acquired.directory, "borrowed"));
      await acquired.close();
      expect(await readFile(join(outside, "sentinel"), "utf8")).toBe("outside remains");
      expect((await lstat(outside)).mode & 0o777).toBe(before);
    });
  });
  it("copies binary files independently without needing host links or POSIX permissions", async () => {
    await fixture(async (root) => {
      const source = join(root, "original"), target = join(root, "source");
      await mkdir(source);
      const bytes = new Uint8Array([0, 255, 128, 13, 10, 42]);
      await writeFile(join(source, "a"), bytes);
      await copy(source, target, [[source, target]]);
      await writeFile(join(source, "a"), new Uint8Array([7]));
      expect(new Uint8Array(await readFile(join(target, "a")))).toEqual(bytes);
    });
  });
  it("emits portable Linux headers and relative aliases without host symlink privileges", async () => {
    await fixture(async (root) => {
      await mkdir(join(root, "source"));
      const bytes = new Uint8Array([0, 255, 128, 13, 10, 42]);
      await writeFile(join(root, "source/a"), bytes);
      const manifest = {
        version: 1,
        roots: ["source"],
        entries: {
          source: { kind: "directory", mode: 0o555 },
          "source/a": {
            kind: "file",
            mode: 0o444,
            links: 1,
            bytes: bytes.length,
            sha256: createHash("sha256").update(bytes).digest("hex"),
          },
          "source/alias": { kind: "link", mode: 0o777, target: "a" },
        },
      };
      await writeFile(join(root, "manifest.json"), JSON.stringify(manifest));
      const archive = join(root, "inputs.tar");
      const authority = await pack(root, manifest, archive);
      expect(authority.name).toBe("archiver");
      // Independently decode these fixed, short POSIX tar headers. No extractor
      // or candidate manifest supplies the expected bytes, kind or alias target.
      const tar = await readFile(archive), decoder = new TextDecoder();
      const fields = new Map<string, { mode: number; kind: string; target: string; bytes: Uint8Array }>();
      for (let offset = 0; offset < tar.length && tar[offset] !== 0;) {
        const text = (start: number, length: number): string =>
          decoder.decode(tar.subarray(offset + start, offset + start + length)).split("\0")[0] ?? "";
        const size = Number.parseInt(text(124, 12), 8);
        fields.set(text(0, 100), {
          mode: Number.parseInt(text(100, 8), 8),
          kind: text(156, 1),
          target: text(157, 100),
          bytes: tar.subarray(offset + 512, offset + 512 + size),
        });
        offset += 512 + Math.ceil(size / 512) * 512;
      }
      expect([...fields.keys()]).toEqual(["manifest.json", "source/", "source/a", "source/alias"]);
      expect(fields.get("source/")?.mode).toBe(0o555);
      expect(fields.get("source/a")?.mode).toBe(0o444);
      expect(new Uint8Array(fields.get("source/a")!.bytes)).toEqual(bytes);
      expect(fields.get("source/alias")?.kind).toBe("2");
      expect(fields.get("source/alias")?.target).toBe("a");
    });
  });
  it("keeps compiled dependency build/dist bytes while omitting repository administration", async () => {
    await fixture(async (root) => {
      const source = join(root, "installed"), target = join(root, "source");
      await mkdir(join(source, "build"), { recursive: true });
      await mkdir(join(source, "dist"));
      await mkdir(join(source, ".git"));
      await writeFile(join(source, "build/index.js"), "export const build = true;");
      await writeFile(join(source, "dist/index.js"), "export const dist = true;");
      await writeFile(join(source, ".git/HEAD"), "not a runtime input");
      await copy(source, target, [[source, target]], undefined, undefined, new Set([".git", ".tmp", ".release"]));
      expect(await readFile(join(target, "build/index.js"), "utf8")).toBe("export const build = true;");
      expect(await readFile(join(target, "dist/index.js"), "utf8")).toBe("export const dist = true;");
      await expect(lstat(join(target, ".git"))).rejects.toThrow();
    });
  });
  it(
    "materializes legitimate input hardlinks independently and rebases an absolute internal alias",
    POSIX,
    async () => {
      await fixture(async (root) => {
        const source = join(root, "original"), target = join(root, "source");
        await mkdir(source);
        await writeFile(join(source, "a"), "independent bytes");
        await link(join(source, "a"), join(source, "b"));
        await symlink(join(source, "a"), join(source, "alias"));
        expect((await lstat(join(source, "a"))).nlink).toBe(2);
        await copy(source, target, [[source, target]]);
        expect((await lstat(join(target, "a"))).nlink).toBe(1);
        expect((await lstat(join(target, "b"))).nlink).toBe(1);
        expect(await realpath(join(target, "alias"))).toBe(join(target, "a"));
        expect(await readFile(join(target, "alias"), "utf8")).toBe("independent bytes");
        await writeFile(join(source, "a"), "changed original");
        expect(await readFile(join(target, "a"), "utf8")).toBe("independent bytes");
        expect(await readFile(join(target, "b"), "utf8")).toBe("independent bytes");
      });
    },
  );

  it("rejects an escaped alias without acquiring its target", POSIX, async () => {
    await fixture(async (root) => {
      const source = join(root, "original"), target = join(root, "source");
      await mkdir(source);
      await writeFile(join(root, "borrowed"), "leave borrowed bytes alone");
      await symlink(join(root, "borrowed"), join(source, "alias"));
      await expect(copy(source, target, [[source, target]])).rejects.toThrow();
      expect(await readFile(join(root, "borrowed"), "utf8")).toBe("leave borrowed bytes alone");
    });
  });

  it("checks an independent manifest against bytes, exact membership and readonly modes", POSIX, async () => {
    await fixture(async (root) => {
      const source = join(root, "source");
      await mkdir(source, { mode: 0o755 });
      await writeFile(join(source, "a"), "oracle");
      await chmod(join(source, "a"), 0o444);
      await chmod(source, 0o700);
      const manifest = {
        version: 1,
        roots: ["source"],
        entries: {
          source: { kind: "directory", mode: 0o700 },
          "source/a": {
            kind: "file",
            mode: 0o444,
            links: 1,
            bytes: 6,
            sha256: createHash("sha256").update("oracle").digest("hex"),
          },
        },
      };
      await verify(root, manifest);
      await chmod(join(source, "a"), 0o644);
      await expect(verify(root, manifest)).rejects.toThrow();
      await writeFile(join(source, "a"), "broken");
      await chmod(join(source, "a"), 0o444);
      await expect(verify(root, manifest)).rejects.toThrow();
      await chmod(source, 0o755);
      await writeFile(join(source, "unexpected"), "extra input");
      await chmod(source, 0o700);
      await expect(verify(root, manifest)).rejects.toThrow();
      await chmod(source, 0o700);
    });
  });

  it("rejects target hardlink substitution even when the byte digest agrees", POSIX, async () => {
    await fixture(async (root) => {
      const source = join(root, "source");
      await mkdir(source);
      await writeFile(join(root, "borrowed"), "oracle");
      await link(join(root, "borrowed"), join(source, "a"));
      await chmod(join(source, "a"), 0o444);
      await chmod(source, 0o700);
      const manifest = {
        version: 1,
        roots: ["source"],
        entries: {
          source: { kind: "directory", mode: 0o700 },
          "source/a": {
            kind: "file",
            mode: 0o444,
            links: 1,
            bytes: 6,
            sha256: createHash("sha256").update("oracle").digest("hex"),
          },
        },
      };
      await expect(verify(root, manifest)).rejects.toThrow();
      expect(await readFile(join(root, "borrowed"), "utf8")).toBe("oracle");
      await unlink(join(root, "borrowed"));
      await chmod(source, 0o700);
    });
  });

  it("preserves cancellation reason before acquiring destination files", async () => {
    await fixture(async (root) => {
      const source = join(root, "original"), target = join(root, "source");
      await mkdir(source);
      await writeFile(join(source, "a"), "kept");
      const controller = new AbortController(), reason = { reason: "owned cancellation" };
      controller.abort(reason);
      let rejected: unknown;
      try {
        await copy(source, target, [[source, target]], undefined, controller.signal);
      } catch (error) {
        rejected = error;
      }
      expect(rejected).toBe(reason);
      await expect(lstat(target)).rejects.toThrow();
      expect(await readFile(join(source, "a"), "utf8")).toBe("kept");
    });
  });
});
