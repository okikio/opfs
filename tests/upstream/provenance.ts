import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";

/** Original-byte attribution is independent of runtime behavior and adapted callback formatting. */
interface SourceType {
  readonly repository: string;
  readonly commit: string;
  readonly path: string;
  readonly retained: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly url: string;
}

/** Captured manifest and original bytes can be compared before and after a workload. */
export interface ProvenanceType {
  readonly manifest: string;
  readonly files: Readonly<Record<string, string>>;
}

/** Enumerates only inert snapshots, rejecting symlinks and unexplained extra files. */
async function files(directory: URL, prefix: string): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const name = `${prefix}${entry.name}`;
    if (entry.isDirectory()) result.push(...await files(new URL(`${entry.name}/`, directory), `${name}/`));
    else if (entry.isFile()) result.push(name);
    else throw new Error(`Pinned snapshot is not a regular file: ${name}`);
  }
  return result;
}

/** Verifies every source/license hash and returns their identity without importing a test runner. */
export async function inspect(): Promise<ProvenanceType> {
  const bytes = await readFile(new URL("./provenance.json", import.meta.url));
  const manifest = JSON.parse(bytes.toString("utf8")) as { format: number; files: SourceType[] };
  assert.equal(manifest.format, 1);
  assert.ok(manifest.files.length > 0, "The upstream manifest must contain original snapshots.");
  const expected: string[] = [];
  const hashes: Record<string, string> = {};
  for (const source of manifest.files) {
    assert.match(source.commit, /^[a-f0-9]{40}$/);
    assert.match(source.sha256, /^[a-f0-9]{64}$/);
    assert.match(source.retained, /^original\/[^.].*\.txt$/);
    assert.ok(!source.retained.split("/").includes(".."), "Snapshot paths must remain within the fixture.");
    assert.equal(source.url, `https://github.com/${source.repository}/blob/${source.commit}/${source.path}`);
    const bytes = await readFile(new URL(source.retained, import.meta.url));
    const hash = createHash("sha256").update(bytes).digest("hex");
    assert.equal(bytes.byteLength, source.bytes, `${source.retained}: source byte count`);
    assert.equal(hash, source.sha256, `${source.retained}: source SHA-256`);
    expected.push(source.retained);
    hashes[source.retained] = hash;
  }
  assert.equal(new Set(expected).size, expected.length, "Snapshot entries must be unique.");
  assert.deepEqual((await files(new URL("./original/", import.meta.url), "original/")).sort(), expected.sort());
  return { manifest: createHash("sha256").update(bytes).digest("hex"), files: hashes };
}
