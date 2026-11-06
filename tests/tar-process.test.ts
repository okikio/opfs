import { describe, it } from "node:test";
import { spawnSync } from "node:child_process";
import { expect } from "@std/expect";
import { lstatSync, mkdtempSync, readFileSync, readlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { env } from "node:process";
import { createTarStream } from "../src/archive/stream.ts";

describe("independent TAR consumers", () => {
  it("system tar extracts PAX writer paths, links, directories and every original payload byte", async () => {
    const payload = Uint8Array.from({ length: 513 }, (_, index) => index % 256);
    const name = "caf\u00e9/" + "long-name-".repeat(20);
    const link = "target/" + "q".repeat(130);
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(payload);
        controller.close();
      },
    });
    const output = new Uint8Array(
      await new Response(createTarStream([
        { name, size: payload.length, body },
        { name: "link", kind: "symbolic-link", link, size: 0 },
        { name: "empty/", kind: "directory", size: 0 },
      ])).arrayBuffer(),
    );
    // GNU tar escapes non-ASCII names under the C locale. The Linux interop
    // runner supplies C.UTF-8 so this assertion checks the actual Unicode name.
    const locale = { ...env, LANG: "C.UTF-8", LC_ALL: "C.UTF-8" };
    const listing = spawnSync("tar", ["-tf", "-"], {
      input: output,
      env: locale,
      encoding: "utf8",
      timeout: 10_000,
      maxBuffer: 64 * 1024,
    });
    expect(listing.error).toBeUndefined();
    expect(listing.status, listing.stderr).toBe(0);
    expect(listing.stdout.trimEnd().split(/\r?\n/u)).toEqual([name, "link", "empty/"]);
    const owned = mkdtempSync(join(tmpdir(), "opfs-tar-consumer-"));
    try {
      // Only the three authored safe names are selected. The created link is
      // inspected as a link and is never followed to a target during verification.
      const result = spawnSync("tar", ["-xf", "-", "-C", owned, "--", name, "link", "empty/"], {
        input: output,
        env: locale,
        encoding: "utf8",
        timeout: 10_000,
        maxBuffer: 64 * 1024,
      });
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(0);
      expect(lstatSync(join(owned, name)).isFile()).toBe(true);
      expect(lstatSync(join(owned, name)).size).toBe(payload.length);
      expect(new Uint8Array(readFileSync(join(owned, name)))).toEqual(payload);
      expect(lstatSync(join(owned, "link")).isSymbolicLink()).toBe(true);
      expect(readlinkSync(join(owned, "link"))).toBe(link);
      expect(lstatSync(join(owned, "empty")).isDirectory()).toBe(true);
    } finally {
      rmSync(owned, { recursive: true, force: true });
    }
  });

  it("the system BSD/GNU tar consumer extracts the selected writer member to stdout without host extraction", async () => {
    const name = "directory/" + "n".repeat(130);
    const payload = new TextEncoder().encode("independent system tar oracle\n");
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(payload);
        controller.close();
      },
    });
    const output = new Uint8Array(
      await new Response(createTarStream([{ name, size: payload.length, body }])).arrayBuffer(),
    );
    const result = spawnSync("tar", ["-xOf", "-", name], { input: output, timeout: 10_000, maxBuffer: 64 * 1024 });
    expect(result.error).toBeUndefined();
    expect(result.status, new TextDecoder().decode(result.stderr)).toBe(0);
    expect(new Uint8Array(result.stdout)).toEqual(payload);
  });
});
