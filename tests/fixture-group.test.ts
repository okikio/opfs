import { describe, it } from "node:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { expect } from "@std/expect";
import { group } from "./fixtures/group.ts";

/** Linux process groups are the actual fixture boundary; other hosts cannot emulate that authority. */
describe("Linux native fixture process ownership", { skip: process.platform !== "linux" }, () => {
  it("preserves a native nonzero exit after both diagnostic pipes finish", async () => {
    const root = await mkdtemp(join(tmpdir(), "opfs-group-"));
    try {
      const log = join(root, "command.log");
      const result = await group({
        command: "node",
        args: ["-e", 'process.stdout.write("out");process.stderr.write("err");process.exitCode=7'],
        log,
        seconds: 5,
        bytes: 128,
      });
      expect(result.exit).toBe(7);
      expect(result.reason).toBe(null);
      expect(result.cleanupFaults).toEqual([]);
      expect(result.logBytes).toBe(6);
      const body = await readFile(log, "utf8");
      expect(body).toContain("out");
      expect(body).toContain("err");
    } finally {
      await rm(root, { recursive: true });
    }
  });

  it("retains only the admitted bytes and retires a producer that exceeds its combined quota", async () => {
    const root = await mkdtemp(join(tmpdir(), "opfs-group-"));
    try {
      const log = join(root, "command.log");
      const result = await group({
        command: "node",
        args: ["-e", "process.stdout.write(Buffer.alloc(8192,65));setInterval(()=>{},1000)"],
        log,
        seconds: 5,
        bytes: 128,
      });
      expect(result.exit).toBe(125);
      expect(result.reason).toBe("combined diagnostic cap");
      expect(result.logBytes).toBe(128);
      expect((await stat(log)).size).toBe(128);
      expect(result.cleanupFaults).toEqual([]);
    } finally {
      await rm(root, { recursive: true });
    }
  });

  it("kills the owned descendant after the leader exits while inherited pipes remain open", async () => {
    const root = await mkdtemp(join(tmpdir(), "opfs-group-"));
    try {
      const log = join(root, "command.log"), marker = join(root, "late-write");
      const descendant =
        'const fs=require("node:fs");process.stdout.write("ready\\n");setTimeout(()=>fs.writeFileSync(process.argv[1],"escaped"),2000)';
      const leader =
        'const {spawn}=require("node:child_process");const child=spawn(process.execPath,["-e",process.argv[1],process.argv[2]],{stdio:["ignore","inherit","inherit"]});child.unref();';
      const result = await group({
        command: "node",
        args: ["-e", leader, descendant, marker],
        log,
        seconds: 1,
        bytes: 1024,
      });
      expect(await readFile(log, "utf8")).toContain("ready");
      expect(result.reason).toBe("whole process-group deadline");
      expect(result.exit).toBe(125);
      expect(result.cleanupFaults).toEqual([]);
      await new Promise((resolve) => setTimeout(resolve, 1400));
      await expect(stat(marker)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(root, { recursive: true });
    }
  });

  it("rejects nonfinite time and fractional quotas before creating a log", async () => {
    const root = await mkdtemp(join(tmpdir(), "opfs-group-"));
    try {
      for (const [seconds, bytes] of ([[Infinity, 128], [1, 1.5], [2147484, 128]] as const)) {
        const log = join(root, "rejected.log");
        await expect(group({ command: "node", args: [], log, seconds, bytes })).rejects.toThrow();
        await expect(stat(log)).rejects.toMatchObject({ code: "ENOENT" });
      }
    } finally {
      await rm(root, { recursive: true });
    }
  });
});
