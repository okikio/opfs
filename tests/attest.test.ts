import { describe, it } from "node:test";
import { expect } from "@std/expect";
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { platform } from "node:process";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { approval } from "../.mise/tasks/attest.mjs";
import { withReleases } from "./close.ts";

/** Real gate controls are host POSIX observations, not Docker runtime/capability claims. */
const POSIX = {
  skip: platform === "win32" ? "POSIX gate mode and alias observations require a supporting host." : false,
};
async function fixture(action: (root: string) => Promise<void>): Promise<void> {
  await withReleases(async (leases) => {
    const temporary = await mkdtemp(join(tmpdir(), "attest-control-"));
    leases.push(() => rm(temporary, { recursive: true, force: true }));
    const root = await realpath(temporary);
    await action(root);
  });
}

/** Expected process identity is independently authored; private approval accepts real fixture owner metadata. */
async function gate(root: string) {
  const directory = join(root, "gate");
  await mkdir(directory, { mode: 0o700 });
  if (platform !== "win32") await chmod(directory, 0o700);
  const identity = await lstat(directory);
  const expected = {
    pid: 123,
    nonce: "01234567-89ab-cdef-0123-456789abcdef",
    role: "ordinary",
    uid: identity.uid,
    gid: identity.gid,
  };
  return { directory, identity, expected, bytes: `123 ${expected.nonce} ordinary\n` };
}

describe("independent native runtime attestation gate", () => {
  it("retains actual early child failure and retires its private gate without certifying behavior", {
    skip: platform !== "linux"
      ? "Actual proc supervisor executes only in Linux; portable gate controls remain separate."
      : false,
  }, async () => {
    const directory = `/tmp/library-attest-${crypto.randomUUID()}`;
    const output = await new Promise<{ error: Error | null; stdout: string }>((accept) => {
      execFile(
        "/bin/sh",
        [
          fileURLToPath(new URL("../.mise/tasks/attest.sh", import.meta.url)),
          "ordinary",
          directory,
          crypto.randomUUID(),
          "/bin/sh",
          "-c",
          "exit 9",
        ],
        { encoding: "utf8", env: {}, timeout: 45_000, maxBuffer: 65536 },
        (error, stdout) => accept({ error, stdout }),
      );
    });
    expect(output.error).toMatchObject({ code: 76 });
    const events = output.stdout.split("\n").filter((line) => line.startsWith("{")).map((line) => JSON.parse(line));
    expect(events).toContainEqual(expect.objectContaining({ phase: "attestation-child", exit: 9 }));
    await expect(lstat(directory)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it(
    "admits exact real approval and rejects wrong identity, trailing bytes and oversized data",
    POSIX,
    () =>
      fixture(async (root) => {
        const value = await gate(root);
        for (
          const bytes of [
            value.bytes,
            value.bytes.replace("123 ", "124 "),
            value.bytes.replace("01234567-89ab", "11234567-89ab"),
            value.bytes.replace("ordinary", "root"),
            value.bytes + "\n",
            "x".repeat(65536),
          ]
        ) {
          await writeFile(join(value.directory, "approval"), bytes, { mode: 0o400 });
          await chmod(join(value.directory, "approval"), 0o400);
          if (bytes === value.bytes) await approval(value.directory, value.identity, value.expected);
          else await expect(approval(value.directory, value.identity, value.expected)).rejects.toThrow();
          await chmod(join(value.directory, "approval"), 0o600);
        }
      }),
  );

  it(
    "refuses alias approval without reading or changing its outside byte and mode sentinel",
    POSIX,
    () =>
      fixture(async (root) => {
        const value = await gate(root), outside = join(root, "outside");
        const bytes = new Uint8Array([0, 255, 128, 13, 10]);
        await writeFile(outside, bytes, { mode: 0o640 });
        await chmod(outside, 0o640);
        const before = await lstat(outside, { bigint: true });
        await symlink(outside, join(value.directory, "approval"));
        await expect(approval(value.directory, value.identity, value.expected)).rejects.toThrow();
        expect(new Uint8Array(await readFile(outside))).toEqual(bytes);
        expect((await lstat(outside)).mode & 0o777).toBe(0o640);
        expect(await lstat(outside, { bigint: true })).toMatchObject({
          dev: before.dev,
          ino: before.ino,
          uid: before.uid,
          gid: before.gid,
          mode: before.mode,
          nlink: before.nlink,
          size: before.size,
        });
      }),
  );

  it(
    "refuses a substituted physical gate even when replacement owner and modes match",
    POSIX,
    () =>
      fixture(async (root) => {
        const value = await gate(root);
        await rename(value.directory, join(root, "acquired"));
        await mkdir(value.directory, { mode: 0o700 });
        await chmod(value.directory, 0o700);
        await writeFile(join(value.directory, "approval"), value.bytes, { mode: 0o400 });
        const before = await lstat(value.directory, { bigint: true });
        const approvalBefore = await lstat(join(value.directory, "approval"), { bigint: true });
        expect(before.uid).toBe(BigInt(value.identity.uid));
        expect(before.gid).toBe(BigInt(value.identity.gid));
        expect(before.mode & 0o777n).toBe(BigInt(value.identity.mode & 0o777));
        expect(before.ino).not.toBe(BigInt(value.identity.ino));
        await expect(approval(value.directory, value.identity, value.expected)).rejects.toThrow();
        expect(await readFile(join(value.directory, "approval"), "utf8")).toBe(value.bytes);
        expect((await lstat(value.directory)).mode & 0o777).toBe(0o700);
        expect(await lstat(value.directory, { bigint: true })).toMatchObject({
          dev: before.dev,
          ino: before.ino,
          uid: before.uid,
          gid: before.gid,
          mode: before.mode,
          nlink: before.nlink,
          size: before.size,
        });
        expect(await lstat(join(value.directory, "approval"), { bigint: true })).toMatchObject({
          dev: approvalBefore.dev,
          ino: approvalBefore.ino,
          uid: approvalBefore.uid,
          gid: approvalBefore.gid,
          mode: approvalBefore.mode,
          nlink: approvalBefore.nlink,
          size: approvalBefore.size,
        });
      }),
  );
});
