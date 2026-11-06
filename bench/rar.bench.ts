import { bench, do_not_optimize } from "mitata";
import { decodeBase64 } from "@std/encoding/base64";
import { createBlobSource } from "../src/source.ts";
import { openRar } from "../src/archive/rar.ts";
import { expectBytes, report } from "./result.ts";
import receipt from "../tests/fixtures/rar/independent.json" with { type: "json" };

// Question: what does full-member CRC verification cost when the caller wants
// only a prefix? The preindexed native Blob baseline copies an exact interval,
// without indexing, checksums or ledger admission. It has different semantics.
const fixture = receipt.fixtures.find((item) => item.profile === "stored")!;
const originals: Readonly<Record<string, { readonly base64: string }>> = fixture.payloads;
const raw = decodeBase64(fixture.archive.base64);
const blob = new Blob([new Uint8Array(raw).buffer]);
const source = createBlobSource(blob);
// Repeated sampling shares finite lifetime limits; each read still uses its
// ordinary per-operation defaults. This allowance is not a production default.
const archive = await openRar(source, {
  maxSourceBytes: 64 * 1024 ** 3,
  maxDecodedBytes: 64 * 1024 ** 3,
  maxOutputBytes: 1024 ** 3,
  maxRequests: 10_000_000,
});
for (const entry of archive.entries) {
  const original = originals[entry.name];
  if (!original) throw new Error("RAR benchmark original payload oracle is missing.");
  expectBytes((await archive.read(entry.id)).bytes, decodeBase64(original.base64), `rar/${entry.name}/complete-oracle`);
}
const context = `rar/image=${raw.length}B entries=${archive.entries.length}`;
const cold = await openRar(source);
if (cold.entries.length !== archive.entries.length) throw new Error("RAR cold listing differs.");
bench(
  `${context} cold index source=${cold.work.sourceBytes}B requests=${cold.work.requests} output=0B integrity=header-crc32-verified`,
  async () => {
    do_not_optimize(await openRar(source));
  },
);
const entry = archive.entries.find((item) => item.name === "large.bin")!;
const expected = decodeBase64(originals[entry.name]!.base64);
const full = await archive.read(entry.id);
expectBytes(full.bytes, expected, "rar/full/preflight");
bench(
  `${context} warm full output=${entry.size}B source=${full.work.sourceBytes}B requests=${full.work.requests} integrity=${full.integrity}`,
  async () => {
    do_not_optimize(await archive.read(entry.id));
  },
);
for (const offset of [0, 65530, entry.size - 37]) {
  const length = 37;
  const wanted = expected.subarray(offset, offset + length);
  const checked = await archive.read(entry.id, { offset, length });
  const deferred = await archive.read(entry.id, { offset, length, verify: false });
  const native = () => blob.slice(entry.offset + offset, entry.offset + offset + length).arrayBuffer();
  expectBytes(checked.bytes, wanted, `rar/${offset}/verified-preflight`);
  expectBytes(deferred.bytes, wanted, `rar/${offset}/deferred-preflight`);
  expectBytes(new Uint8Array(await native()), wanted, `rar/${offset}/native-preflight`);
  if (
    checked.integrity !== "crc32-verified" || checked.work.sourceBytes !== entry.size ||
    checked.work.requests !== Math.ceil(entry.size / 65536) || deferred.integrity !== "pending" ||
    deferred.work.sourceBytes !== length || deferred.work.requests !== 1
  ) {
    throw new Error("RAR verification/range physical accounting changed.");
  }
  const range = `${context} member=${entry.size}B offset=${offset}B output=${length}B`;
  bench(`${range} native preindexed Blob source=${length}B requests=1 integrity=none`, async () => {
    do_not_optimize(await native());
  });
  bench(
    `${range} warm verified source=${checked.work.sourceBytes}B requests=${checked.work.requests} integrity=${checked.integrity}`,
    async () => {
      do_not_optimize(await archive.read(entry.id, { offset, length }));
    },
  );
  bench(
    `${range} warm deferred source=${deferred.work.sourceBytes}B requests=${deferred.work.requests} integrity=${deferred.integrity}`,
    async () => {
      do_not_optimize(await archive.read(entry.id, { offset, length, verify: false }));
    },
  );
}
await report();
