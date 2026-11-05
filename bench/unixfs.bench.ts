import { bench, do_not_optimize } from "mitata";
import { decodeBase64 } from "@std/encoding/base64";
import { openUnixfs } from "../src/content/unixfs.ts";
import type { UnixfsBlockReaderType, UnixfsFileType, UnixfsWorkType } from "../src/content/unixfs.ts";
import { parseCid } from "../src/content/cid.ts";
import fixture from "../tests/fixtures/unixfs/independent.json" with { type: "json" };
import { expectBytes, report } from "./result.ts";

// Question: how much serialized-block acquisition, hashing and graph work does a selected range need,
// compared with cold namespace opening or explicit complete-file verification? Fixtures and original-byte
// checks are outside timing. The backing map is borrowed; these are in-memory protocol costs, not IPFS network costs.
const subtle = crypto.subtle;
const allowance = {
  maxSourceBytes: 64 * 1024 ** 3,
  maxDecodedBytes: 64 * 1024 ** 3,
  maxOutputBytes: 64 * 1024 ** 3,
  maxRequests: 10000000,
};
function label(work: UnixfsWorkType): string {
  return `source=${work.sourceBytes}B requests=${work.requests} decoded=${work.decodedBytes}B output=${work.outputBytes}B edges=${work.edges} steps=${work.steps} cache=${work.cacheBytes}B hits=${work.cacheHits}`;
}
for (const profile of fixture.profiles) {
  const blocks = new Map(profile.blocks.map((item) => [parseCid(item.cid).id, decodeBase64(item.base64)]));
  const reader: UnixfsBlockReaderType = async (cid, options) => {
    const bytes = blocks.get(cid);
    if (!bytes || bytes.length > options.maxBytes) throw new Error("Benchmark block absent or over cap");
    return bytes;
  };
  const selected = async (name: string, cache = 4194304): Promise<UnixfsFileType> => {
    const root = await openUnixfs(profile.cid, reader, { ...allowance, subtle, maxCacheBytes: cache });
    if (root.kind !== "directory") throw new Error("Expected native directory");
    const parent = name.includes("/") ? await root.open("nested", allowance) : root;
    if (parent.kind !== "directory") throw new Error("Expected native nested directory");
    const file = await parent.open(name.includes("/") ? "data.bin" : name, allowance);
    if (file.kind !== "file") throw new Error("Expected native file");
    return file;
  };
  const original = decodeBase64(profile.files.find((item) => item.path === "nested/data.bin")!.base64);
  const file = await selected("nested/data.bin");
  expectBytes((await file.read()).bytes, original, `unixfs/${profile.profile}/complete-native-original`);
  bench(
    `unixfs/${profile.profile} cold-file-index node-hashes=3 content=not-read`,
    async () => do_not_optimize(await selected("nested/data.bin")),
  );
  const plain = new Blob([new Uint8Array(original).buffer]);
  for (const mode of ["full-range", "prefix", "late"] as const) {
    const offset = mode === "late" ? original.length - 40 : 0, length = mode === "full-range" ? original.length : 32;
    const options = { offset, length }, result = await file.read(options);
    expectBytes(result.bytes, original.subarray(offset, offset + length), `unixfs/${profile.profile}/${mode}/original`);
    bench(
      `unixfs/${profile.profile} ${mode} selected=${offset}+${length} ${
        label(result.work)
      } hash=selected-blocks complete-file=not-claimed`,
      async () => do_not_optimize(await file.read(options)),
    );
    bench(
      `unixfs/${profile.profile} ${mode} decoded-Blob-copy lower-bound hash=none`,
      async () => do_not_optimize(await plain.slice(offset, offset + length).arrayBuffer()),
    );
  }
  const verified = await file.verify();
  bench(
    `unixfs/${profile.profile} complete-file-traversal ${label(verified.work)} hash=all-file-blocks returned=0B`,
    async () => do_not_optimize(await file.verify()),
  );
}
// Same genuine repeated-content DAG with and without the bounded operation-local cache.
const profile = fixture.profiles[0]!;
for (const cache of [0, 4194304]) {
  const blocks = new Map(profile.blocks.map((item) => [parseCid(item.cid).id, decodeBase64(item.base64)]));
  const root = await openUnixfs(profile.cid, async (cid) => {
    const bytes = blocks.get(cid);
    if (!bytes) throw new Error("Benchmark block absent");
    return bytes;
  }, { ...allowance, subtle, maxCacheBytes: cache });
  if (root.kind !== "directory") throw new Error("Expected directory");
  const file = await root.open("repeat.bin", allowance);
  if (file.kind !== "file") throw new Error("Expected file");
  expectBytes(
    (await file.read()).bytes,
    decodeBase64(profile.files.find((item) => item.path === "repeat.bin")!.base64),
    "unixfs/cache/complete-original",
  );
  const result = await file.verify();
  bench(
    `unixfs/repeated-content cache-cap=${cache}B complete-file ${label(result.work)}`,
    async () => do_not_optimize(await file.verify()),
  );
}
await report();
