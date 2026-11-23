import { bench, do_not_optimize } from "mitata";
import { decodeBase64 } from "@std/encoding/base64";
import { createBlobSource } from "../src/source.ts";
import { openLha } from "../src/archive/lha.ts";
import { expectBytes, report } from "./result.ts";
import receipt from "../tests/fixtures/lha/independent.json" with { type: "json" };

// Question: what does whole-member CRC16 cost when the caller wants a small
// preview? Native Blob receives an already known physical extent and omits
// header parsing, checksums and aggregate admission. It is a different contract.
for (const fixture of receipt.fixtures) {
  const raw = decodeBase64(fixture.archive.base64);
  const blob = new Blob([new Uint8Array(raw).buffer]);
  const source = createBlobSource(blob);
  // Repeated sampling has finite aggregate allowances; each read retains normal
  // operation defaults. These allowances are not production recommendations.
  const archive = await openLha(source, {
    maxSourceBytes: 64 * 1024 ** 3,
    maxDecodedBytes: 64 * 1024 ** 3,
    maxOutputBytes: 1024 ** 3,
    maxRequests: 10_000_000,
  });
  const payloads: Readonly<Record<string, { readonly base64: string }>> = fixture.payloads;
  for (const entry of archive.entries.filter((entry) => entry.readable)) {
    const original = payloads[entry.name.replaceAll("\\", "/")];
    if (!original) throw new Error("LHA benchmark original payload is missing.");
    expectBytes(
      (await archive.read(entry.id)).bytes,
      decodeBase64(original.base64),
      `lha/${fixture.level}/${entry.name}/full-oracle`,
    );
  }
  const label = `lha/level=${fixture.level} image=${raw.length}B entries=${archive.entries.length}`;
  const cold = await openLha(source);
  if (cold.entries.length !== archive.entries.length) throw new Error("LHA cold index differs.");
  bench(
    `${label} cold index source=${cold.work.sourceBytes}B requests=${cold.work.requests} output=0B header-integrity=verified`,
    async () => {
      do_not_optimize(await openLha(source));
    },
  );
  const entry = archive.entries.find((entry) => entry.name === "many.bin");
  const original = payloads["many.bin"];
  if (!entry || !original) throw new Error("LHA representative member is missing.");
  const expected = decodeBase64(original.base64);
  const full = await archive.read(entry.id);
  expectBytes(full.bytes, expected, `lha/${fixture.level}/full/preflight`);
  bench(
    `${label} full output=${entry.size}B source=${full.work.sourceBytes}B requests=${full.work.requests} integrity=${full.integrity}`,
    async () => {
      do_not_optimize(await archive.read(entry.id));
    },
  );
  const offset = entry.size - 37;
  const length = 37;
  const native = () => blob.slice(entry.offset + offset, entry.offset + offset + length).arrayBuffer();
  const selected = expected.subarray(offset, offset + length);
  const checked = await archive.read(entry.id, { offset, length });
  const deferred = await archive.read(entry.id, { offset, length, verify: false });
  expectBytes(checked.bytes, selected, `lha/${fixture.level}/verified/preflight`);
  expectBytes(deferred.bytes, selected, `lha/${fixture.level}/deferred/preflight`);
  expectBytes(new Uint8Array(await native()), selected, `lha/${fixture.level}/native/preflight`);
  if (
    checked.work.sourceBytes !== entry.size || checked.work.requests !== Math.ceil(entry.size / 65536) ||
    checked.integrity !== "crc16-verified" || deferred.work.sourceBytes !== length || deferred.work.requests !== 1 ||
    deferred.integrity !== "pending"
  ) {
    throw new Error("LHA preview physical work or checksum scope changed.");
  }
  const range = `${label} member=${entry.size}B offset=${offset}B output=${length}B`;
  bench(`${range} native preindexed Blob source=${length}B requests=1 integrity=none`, async () => {
    do_not_optimize(await native());
  });
  bench(
    `${range} verified source=${checked.work.sourceBytes}B requests=${checked.work.requests} integrity=${checked.integrity}`,
    async () => {
      do_not_optimize(await archive.read(entry.id, { offset, length }));
    },
  );
  bench(
    `${range} deferred source=${deferred.work.sourceBytes}B requests=${deferred.work.requests} integrity=${deferred.integrity}`,
    async () => {
      do_not_optimize(await archive.read(entry.id, { offset, length, verify: false }));
    },
  );
}
await report();
