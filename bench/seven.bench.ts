import { bench, do_not_optimize } from "mitata";
import { decodeBase64 } from "@std/encoding/base64";
import { createBlobSource } from "../src/source.ts";
import { openSeven } from "../src/archive/seven.ts";
import { expectBytes, report } from "./result.ts";
import fixtures from "../tests/fixtures/seven/independent.json" with { type: "json" };

// Question: how do prefix and complete-member verification differ for COPY and
// single-stream LZMA? The COPY-only native Blob baseline receives preindexed
// offsets without parsing, CRC or budgets; compressed lanes have no native codec
// baseline. Fixed fixtures do not establish scaling or remote-provider behavior.
// Warm samples share an index and therefore its lifetime accounting. This finite
// sampling allowance is separate from each read's unchanged default work limits.
const samplingLimits = {
  maxSourceBytes: 64 * 1024 ** 3,
  maxDecodedBytes: 64 * 1024 ** 3,
  maxOutputBytes: 1024 ** 3,
  maxRequests: 10_000_000,
};
for (const profile of ["copy", "lzma1", "lzma2", "encoded-lzma1", "solid"] as const) {
  const fixture = fixtures[profile];
  const bytes = decodeBase64(fixture.archive);
  const blob = new Blob([new Uint8Array(bytes).buffer]);
  const source = createBlobSource(blob);
  const archive = await openSeven(source, samplingLimits);
  bench(
    `seven/${profile} cold index archive=${bytes.length}B source=${archive.work.sourceBytes}B requests=${archive.work.requests}`,
    async () => {
      do_not_optimize(await openSeven(source));
    },
  );
  if (profile !== "copy") {
    if (profile === "solid") continue;
    const entry = archive.entries.find((entry) => entry.name === "large.bin")!;
    const expected = decodeBase64(fixture.entries.find((item) => item.name === entry.name)!.body);
    expectBytes((await archive.read(entry.id)).bytes, expected, `seven/${profile}/full-oracle`);
    for (const offset of [0, 100000]) {
      const length = 3;
      const checked = await archive.read(entry.id, { offset, length });
      const unchecked = await archive.read(entry.id, { offset, length, verify: false });
      expectBytes(checked.bytes, expected.subarray(offset, offset + length), `seven/${profile}/${offset}/checked`);
      expectBytes(unchecked.bytes, expected.subarray(offset, offset + length), `seven/${profile}/${offset}/unchecked`);
      if (
        checked.decoding !== "complete" || checked.integrity !== "crc32-verified" || checked.work.outputBytes !== length
      ) {
        throw new Error("7z compressed benchmark terminal or checksum scope changed.");
      }
      const label = `seven/${profile}/large.bin member=${entry.size}B offset=${offset}B output=${length}B`;
      bench(
        `${label} warm prefix source=${unchecked.work.sourceBytes}B decoded=${unchecked.work.decodedBytes}B termination=${unchecked.decoding}`,
        async () => {
          do_not_optimize(await archive.read(entry.id, { offset, length, verify: false }));
        },
      );
      bench(
        `${label} warm full CRC source=${checked.work.sourceBytes}B decoded=${checked.work.decodedBytes}B`,
        async () => {
          do_not_optimize(await archive.read(entry.id, { offset, length }));
        },
      );
    }
    continue;
  }
  for (const name of ["folder/first.bin", "large.bin"]) {
    const entry = archive.entries.find((entry) => entry.name === name)!;
    const expected = decodeBase64(fixture.entries.find((entry) => entry.name === name)!.body);
    expectBytes((await archive.read(entry.id)).bytes, expected, `seven/${name}/full-payload-oracle`);
    const pack = archive.packs[archive.folders[entry.folderId!]!.packId]!;
    for (const offset of name === "large.bin" ? [0, 100000] : [0]) {
      const length = 3;
      const native = () => blob.slice(pack.offset + offset, pack.offset + offset + length).arrayBuffer();
      const checked = await archive.read(entry.id, { offset, length });
      const unchecked = await archive.read(entry.id, { offset, length, verify: false });
      const oracle = expected.subarray(offset, offset + length);
      expectBytes(checked.bytes, oracle, `seven/${name}/${offset}/checked`);
      expectBytes(unchecked.bytes, oracle, `seven/${name}/${offset}/unchecked`);
      expectBytes(new Uint8Array(await native()), oracle, `seven/${name}/${offset}/native`);
      if (
        checked.work.sourceBytes !== entry.size || unchecked.work.sourceBytes !== length ||
        checked.work.outputBytes !== length || checked.integrity !== "crc32-verified"
      ) {
        throw new Error("7z benchmark work or CRC evidence differs from the independent payload oracle.");
      }
      const label = `seven/COPY/${name} member=${entry.size}B offset=${offset}B output=${length}B`;
      bench(`${label} native preindexed Blob source=${length}B integrity=none`, async () => {
        do_not_optimize(await native());
      });
      bench(
        `${label} warm unchecked source=${unchecked.work.sourceBytes}B decoded=${unchecked.work.decodedBytes}B`,
        async () => {
          do_not_optimize(await archive.read(entry.id, { offset, length, verify: false }));
        },
      );
      bench(`${label} warm CRC source=${checked.work.sourceBytes}B decoded=${checked.work.decodedBytes}B`, async () => {
        do_not_optimize(await archive.read(entry.id, { offset, length }));
      });
      bench(
        `${label} cold index+CRC source=${archive.work.sourceBytes + checked.work.sourceBytes}B decoded=${
          archive.work.decodedBytes + checked.work.decodedBytes
        }B`,
        async () => {
          const cold = await openSeven(source);
          do_not_optimize(await cold.read(entry.id, { offset, length }));
        },
      );
    }
  }
}
await report();
