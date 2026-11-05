import { describe, it } from "node:test";
import { expect } from "@std/expect";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

/** Both programs are owned, bounded children. Capturing the producer avoids a shell pipe masking its failure. */
describe("ZIP independent consumer", () => {
  it("feeds complete output to CPython zipfile and checks its authored payload oracle", () => {
    const fixture = new URL("./fixtures/zip-write/produce.ts", import.meta.url);
    const verifier = new URL("./fixtures/zip-write/verify.py", import.meta.url);
    const produced = spawnSync("node", [fileURLToPath(fixture)], { timeout: 30_000, maxBuffer: 1024 * 1024 });
    expect(produced.error).toBeUndefined();
    expect(produced.signal).toBeNull();
    expect(produced.status, produced.stderr.toString()).toBe(0);
    const consumed = spawnSync("python3", [fileURLToPath(verifier)], {
      input: produced.stdout,
      timeout: 30_000,
      maxBuffer: 64 * 1024,
      encoding: "utf8",
    });
    expect(consumed.error).toBeUndefined();
    expect(consumed.signal).toBeNull();
    expect(consumed.status, consumed.stderr).toBe(0);
    expect(JSON.parse(consumed.stdout)).toMatchObject({
      consumer: "CPython zipfile",
      entries: 4,
      bytes: 485,
      sha256: "1e57289da471b461adffde9d698cd648f03f9277b46f5fe6973310faf206b1d2",
      result: "passed",
    });
  });
});
