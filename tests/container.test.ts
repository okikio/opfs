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
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { platform } from "node:process";
import { expect } from "@std/expect";
import { copy, pack } from "../.mise/tasks/container.mjs";
import { verify } from "../.mise/tasks/container-worker.mjs";
import { withReleases } from "./close.ts";

/** Windows host modes/link privileges do not prove the mandatory private Linux guard. */
const POSIX = {
  skip: platform === "win32" ? "Host POSIX modes and link privileges are not portable observations." : false,
};

/** Restores only this test's private directories; symbolic targets never gain cleanup ownership. */
async function remove(root: string): Promise<void> {
  async function visit(path: string): Promise<void> {
    const info = await lstat(path);
    if (info.isSymbolicLink()) return;
    if (!info.isDirectory()) {
      if (platform === "win32" && info.isFile()) await chmod(path, 0o600);
      return;
    }
    if (platform !== "win32") await chmod(path, 0o700);
    for (const name of await readdir(path)) await visit(join(path, name));
  }
  await visit(root);
  await rm(root, { recursive: true });
}

async function fixture(action: (root: string) => Promise<void>): Promise<void> {
  await withReleases(async (releases) => {
    const root = await mkdtemp(join(tmpdir(), "opfs-input-control-"));
    releases.push(() => remove(root));
    await action(root);
  });
}

describe("container copy admission", () => {
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
      await chmod(source, 0o555);
      const manifest = {
        version: 1,
        roots: ["source"],
        entries: {
          source: { kind: "directory", mode: 0o555 },
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
      await chmod(source, 0o555);
      await expect(verify(root, manifest)).rejects.toThrow();
    });
  });

  it("rejects target hardlink substitution even when the byte digest agrees", POSIX, async () => {
    await fixture(async (root) => {
      const source = join(root, "source");
      await mkdir(source);
      await writeFile(join(root, "borrowed"), "oracle");
      await link(join(root, "borrowed"), join(source, "a"));
      await chmod(join(source, "a"), 0o444);
      await chmod(source, 0o555);
      const manifest = {
        version: 1,
        roots: ["source"],
        entries: {
          source: { kind: "directory", mode: 0o555 },
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
