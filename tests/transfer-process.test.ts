import { describe, it } from "node:test";
import { expect } from "@std/expect";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("transfer process-loss recovery", () => {
  it("reconciles a destination write after process exit before checkpoint publication", () => {
    const directory = mkdtempSync(join(tmpdir(), "opfs-transfer-"));
    try {
      const checkpoint = join(directory, "checkpoint.json");
      const output = join(directory, "output.bin");
      writeFileSync(output, new Uint8Array());
      writeFileSync(
        checkpoint,
        JSON.stringify({
          version: 1,
          protocol: "fixture-v1",
          destination: "https://fixture.example/session/one",
          source: "fixture-immutable-v1",
          size: 5,
          offset: 0,
          state: "active",
        }),
      );
      const code = `
        import { readFileSync, writeFileSync, renameSync } from "node:fs";
        import { resumeTransfer } from ${JSON.stringify(new URL("../src/transfer.ts", import.meta.url).href)};
        const checkpointPath = ${JSON.stringify(checkpoint)};
        const outputPath = ${JSON.stringify(output)};
        const input = new Uint8Array([1, 2, 3, 4, 5]);
        const reads = [];
        const source = { identity: "fixture-immutable-v1", size: input.length, async read(offset, length) {
          reads.push([offset, length]); return input.slice(offset, offset + length);
        } };
        const destination = { protocol: "fixture-v1", url: "https://fixture.example/session/one",
          async status() {
            const offset = readFileSync(outputPath).length;
            return { offset, size: input.length, complete: offset === input.length };
          },
          async write(offset, bytes) {
            const old = readFileSync(outputPath);
            if (offset !== old.length) throw new Error("Duplicate or misplaced output");
            writeFileSync(outputPath, new Uint8Array([...old, ...bytes]));
            if (process.argv[1] === "crash") process.exit(37);
            return offset + bytes.length;
          }
        };
        const result = await resumeTransfer({ source, destination, chunkBytes: 2,
          checkpoint: JSON.parse(readFileSync(checkpointPath, "utf8")),
          async save(value) {
            writeFileSync(checkpointPath + ".tmp", JSON.stringify(value));
            renameSync(checkpointPath + ".tmp", checkpointPath);
          }
        });
        console.log(JSON.stringify({ result, reads }));
      `;
      // Bound each owned child so a recovery regression cannot hold the test runner indefinitely.
      const crash = spawnSync("node", ["--input-type=module", "-e", code, "crash"], {
        encoding: "utf8",
        timeout: 30_000,
      });
      expect(crash.status, crash.stderr).toBe(37);
      expect([...readFileSync(output)]).toEqual([1, 2]);
      expect(JSON.parse(readFileSync(checkpoint, "utf8")).offset).toBe(0);
      const restart = spawnSync("node", ["--input-type=module", "-e", code, "resume"], {
        encoding: "utf8",
        timeout: 30_000,
      });
      expect(restart.status, restart.stderr).toBe(0);
      expect([...readFileSync(output)]).toEqual([1, 2, 3, 4, 5]);
      const result = JSON.parse(restart.stdout);
      expect(result.result).toMatchObject({ state: "completed", offset: 5 });
      expect(result.reads).toEqual([[2, 2], [4, 1]]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
