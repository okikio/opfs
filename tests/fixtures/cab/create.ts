/** Produce CAB archives with gcab and compare cabextract output with originals.
 *
 * Both programs are explicit test-only executables. This producer imports no
 * OPFS code. Use a new --output path; existing historical evidence is not replaced.
 * Each native command has a 15-second deadline and an 8 MiB output cap per pipe.
 * @module
 */
import { deepStrictEqual, ok } from "node:assert";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    gcab: { type: "string", default: "gcab" },
    cabextract: { type: "string", default: "cabextract" },
    output: { type: "string" },
  },
});
ok(values.output, "Supply a new --output JSON path");
const producer = values.gcab;
const consumer = values.cabextract;
ok(producer && consumer);

/** An argument vector avoids shell interpolation of fixture names and paths. */
function run(executable: string, args: string[], cwd?: string): Buffer {
  const result = spawnSync(executable, args, {
    ...(cwd === undefined ? {} : { cwd }),
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 15_000,
    killSignal: "SIGKILL",
    maxBuffer: 8 * 1024 * 1024,
  });
  if (result.error || result.status !== 0 || result.signal) {
    throw new Error(JSON.stringify({
      executable,
      args,
      status: result.status,
      signal: result.signal,
      error: result.error?.message,
      stderr: result.stderr?.toString("utf8"),
    }));
  }
  return result.stdout;
}
const producerVersion = run(producer, ["--version"]).toString().trim();
const consumerVersion = run(consumer, ["--version"]).toString().trim();
const root = mkdtempSync(join(tmpdir(), "opfs-cab-"));
try {
  const inputs: Record<string, Buffer> = {
    "first.bin": Buffer.from(Array.from({ length: 73 }, (_, index) => index)),
    "large.bin": Buffer.from(Array.from({ length: 131072 }, (_, index) => (index * 31 + 17) % 251)),
    "last.bin": Buffer.concat([Buffer.from("last\0binary"), Buffer.from([255]), Buffer.from("bytes!")]),
    empty: Buffer.alloc(0),
    "café.txt": Buffer.from("UTF-8 name payload"),
  };
  for (const [name, bytes] of Object.entries(inputs)) {
    writeFileSync(join(root, name), bytes, { flag: "wx" });
    utimesSync(join(root, name), 946684800, 946684800);
  }
  const records: Record<string, unknown> = {};
  for (const profile of ["stored", "mszip"]) {
    const filename = `${profile}.cab`;
    const flags = profile === "mszip" ? ["-z"] : [];
    const args = ["-c", ...flags, filename, ...Object.keys(inputs)];
    run(producer, args, root);
    const archive = readFileSync(join(root, filename));
    const destination = join(root, `extract-${profile}`);
    mkdirSync(destination);
    run(consumer, ["-q", "-d", destination, join(root, filename)]);
    for (const [name, bytes] of Object.entries(inputs)) deepStrictEqual(readFileSync(join(destination, name)), bytes);
    records[profile] = {
      producer: producerVersion,
      consumer: consumerVersion,
      command: [producer, ...args],
      consumerCommand: [consumer, "-q", "-d", "output", filename],
      sha256: createHash("sha256").update(archive).digest("hex"),
      archive: archive.toString("base64"),
      entries: Object.entries(inputs).map(([name, body]) => ({ name, body: body.toString("base64") })),
    };
  }
  writeFileSync(values.output, JSON.stringify(records, null, 2) + "\n", { flag: "wx" });
} finally {
  rmSync(root, { recursive: true, force: true });
}
