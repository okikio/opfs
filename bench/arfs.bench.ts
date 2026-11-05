import { bench, do_not_optimize } from "mitata";
import { decodeBase64 } from "@std/encoding/base64";
import { openArfs } from "../src/content/arfs.ts";
import { createByteSource } from "../src/source.ts";
import type { ArfsMetadataInputType } from "../src/content/arfs.ts";
import fixture from "../tests/fixtures/arfs/independent.json" with { type: "json" };
import { expectBytes, report } from "./result.ts";

// Question: what do bounded selected-inventory admission and exact range validation cost
// over already supplied immutable bytes? SDK signing, JSON/base64 fixture decoding,
// source construction and every full original-byte oracle are outside timed callbacks.
const records: readonly ArfsMetadataInputType[] = fixture.metadata.map((item) => ({
  transactionId: item.transactionId,
  owner: item.owner,
  tags: item.tags,
  source: createByteSource(decodeBase64(item.bytesBase64), { identity: item.transactionId }),
}));
const inventory = { drive: records[0]!, entities: records.slice(1) };
const original = decodeBase64(fixture.original.bytesBase64);
const borrowed = createByteSource(decodeBase64(fixture.payload.bytesBase64), {
  identity: fixture.payload.transactionId,
});
const data = { transactionId: fixture.payload.transactionId, source: borrowed };
// Sampling reuses one bounded warm lifetime; cold samples create fresh default ledgers.
const allowance = {
  maxSourceBytes: 64 * 1024 ** 3,
  maxDecodedBytes: 64 * 1024 ** 3,
  maxOutputBytes: 64 * 1024 ** 3,
  maxRequests: 10000000,
};
const view = await openArfs(inventory, allowance);
const file = view.file(fixture.ids.file);
expectBytes((await file.read(data)).bytes, original, "arfs/native-sdk/full-original");
expectBytes(await borrowed.read(0, original.length), original, "arfs/borrowed/full-original");
const { offset, length } = fixture.original.range;
const expected = decodeBase64(fixture.original.range.bytesBase64);
expectBytes(expected, original.subarray(offset, offset + length), "arfs/native-sdk/range-oracle");
const selected = await file.read(data, { offset, length });
expectBytes(selected.bytes, expected, "arfs/selected-range/preflight");
const listing = view.list(fixture.ids.root);
if (listing.entries.map((e) => e.name).sort().join("|") !== "nested|pinned.bin") {
  throw new Error("ArFS listing differs from the authored native producer inventory.");
}
const work = view.work;
bench(
  `arfs borrowed-Blob-range lower-bound selected=${offset}+${length}B validation=none transport=none`,
  async () => do_not_optimize(await borrowed.read(offset, length)),
);
bench(
  `arfs cold-supplied-index metadata=5 entities=4 source=${work.sourceBytes}B requests=${work.requests} decoded=${work.decodedBytes}B output=0B signature=not-verified`,
  async () => do_not_optimize(await openArfs(inventory)),
);
bench(
  `arfs selected-file-range selected=${offset}+${length}B source=${selected.work.sourceBytes}B requests=${selected.work.requests} output=${selected.work.outputBytes}B integrity=caller-supplied`,
  async () => do_not_optimize(await file.read(data, { offset, length })),
);
bench(
  "arfs supplied-folder-list indexed-entities=4 returned-entries=2 source=0B payload=not-read scope=supplied-only",
  () => do_not_optimize(view.list(fixture.ids.root)),
);
await report();
