import { bench, do_not_optimize } from "mitata";
import { decodeBase64 } from "@std/encoding/base64";
import { openArj } from "../src/archive/arj.ts";
import { createBlobSource } from "../src/source.ts";
import { expectBytes, report } from "./result.ts";
import native from "../tests/fixtures/arj/independent.json" with { type: "json" };

// Compare physical CRC cost with exact selected output on one native original.
// Cold index reads headers, not every payload. The Blob lane omits that contract.
const item = native.fixtures.find((value) => value.method === 0);
if (!item) throw new Error("ARJ STORED native fixture is missing.");
const payload = item.payloads["many.bin"];
if (!payload) throw new Error("ARJ benchmark original is missing.");
const original = decodeBase64(payload.base64), wire = decodeBase64(item.archive.base64);
const source = createBlobSource(new Blob([new Uint8Array(wire).buffer]));
// Finite sampling allowances span warm operations; per-operation read defaults
// remain separate. These are timing policy, not recommended production budgets.
const allowance = {
  maxSourceBytes: 64 * 1024 ** 3,
  maxDecodedBytes: 64 * 1024 ** 3,
  maxOutputBytes: 4 * 1024 ** 3,
  maxRequests: 10_000_000,
};
const archive = await openArj(source, allowance);
const entry = archive.entries.find((value) => value.name === "many.bin");
if (!entry) throw new Error("ARJ native benchmark entry is missing.");
const from = 17, length = 37;
const selected = original.slice(from, from + length);
const full = await archive.read(entry.id);
const prefix = await archive.read(entry.id, { offset: from, length });
const partial = await archive.read(entry.id, { offset: from, length, verify: false });
expectBytes(full.bytes, original, "arj/native-original-full");
expectBytes(prefix.bytes, selected, "arj/verified-selection");
expectBytes(partial.bytes, selected, "arj/pending-selection");
expectBytes(await source.read(entry.offset + from, length), selected, "arj/native-source-selected");
if (
  prefix.work.sourceBytes !== original.length || partial.work.sourceBytes !== length ||
  prefix.integrity !== "crc32-verified" || partial.integrity !== "pending"
) {
  throw new Error("ARJ benchmark integrity or physical work scope differs.");
}
const cold = async () => {
  const index = await openArj(source);
  const found = index.entries.find((value) => value.name === "many.bin");
  if (!found) throw new Error("ARJ cold entry is missing.");
  return index.read(found.id, { offset: from, length });
};
expectBytes((await cold()).bytes, selected, "arj/cold-open-selected");
bench(
  `arj cold index archive=${wire.length}B headers=${archive.work.sourceBytes}B requests=${archive.work.requests}`,
  async () => {
    do_not_optimize(await openArj(source));
  },
);
bench("arj native Blob selected source=37B output=37B requests=1 no-index-no-CRC", async () => {
  do_not_optimize(await source.read(entry.offset + from, length));
});
bench(
  `arj warm full source=${full.work.sourceBytes}B output=${original.length}B requests=${full.work.requests} CRC32`,
  async () => {
    do_not_optimize(await archive.read(entry.id));
  },
);
bench(
  `arj warm verified selection source=${prefix.work.sourceBytes}B output=37B requests=${prefix.work.requests} CRC32-whole-member`,
  async () => {
    do_not_optimize(await archive.read(entry.id, { offset: from, length }));
  },
);
bench("arj warm pending selection source=37B output=37B requests=1 CRC-pending", async () => {
  do_not_optimize(await archive.read(entry.id, { offset: from, length, verify: false }));
});
bench(
  `arj cold index+verified selection source=${archive.work.sourceBytes + prefix.work.sourceBytes}B output=37B`,
  async () => {
    do_not_optimize(await cold());
  },
);
await report();
