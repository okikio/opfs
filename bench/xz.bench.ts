import { bench, do_not_optimize } from "mitata";
import { decodeBase64 } from "@std/encoding/base64";
import { createBlobSource } from "../src/source.ts";
import { openXz } from "../src/archive/xz.ts";
import { expectBytes, report } from "./result.ts";
import fixtures from "../tests/fixtures/xz/independent.json" with { type: "json" };

// Question: what work does a short prefix avoid, and what does selected-block
// verification cost for CRC32, native-default CRC64 and no payload checksum?
// Native decoded-Blob reads are a lower-bound copy baseline, not an XZ codec.
// CRC32/CRC64 multi-block fixtures have equal original bytes but their genuine
// encoders differ (single/threaded); results cannot isolate checksum CPU alone.
// One index is reused for warm samples. These finite lifetime allowances cover
// repeated sampling, while individual reads retain the normal default limits.
const samplingLimits = {
  maxSourceBytes: 64 * 1024 ** 3,
  maxDecodedBytes: 64 * 1024 ** 3,
  maxOutputBytes: 1024 ** 3,
  maxRequests: 10_000_000,
};
for (const name of ["crc32-blocks", "crc64-default-threaded", "none-literal"] as const) {
  const fixture = fixtures.cases.find((item) => item.name === name);
  if (!fixture) throw new Error(`Missing independent XZ benchmark fixture ${name}`);
  const bytes = decodeBase64(fixture.archive);
  const expected = decodeBase64(fixture.body);
  const source = createBlobSource(new Blob([new Uint8Array(bytes).buffer]));
  const decoded = new Blob([new Uint8Array(expected).buffer]);
  const archive = await openXz(source, samplingLimits);
  const complete = await archive.read();
  expectBytes(complete.bytes, expected, `xz/${name}/complete-original-byte-oracle`);
  const integrity = archive.check === "none" ? "not-provided" : `${archive.check}-verified`;
  if (complete.checks.some((check) => check.integrity !== integrity || check.decoding !== "complete")) {
    throw new Error("XZ benchmark full-block evidence differs from its declared check profile.");
  }
  const label = `xz/${name} archive=${bytes.length}B decoded=${expected.length}B blocks=${archive.blocks.length}`;
  bench(`${label} cold metadata source=${archive.work.sourceBytes}B requests=${archive.work.requests}`, async () => {
    do_not_optimize(await openXz(source));
  });
  bench(
    `${label} warm whole stream source=${complete.work.sourceBytes}B work=${complete.work.decodedBytes}B output=${complete.bytes.length}B check=${archive.check}`,
    async () => {
      do_not_optimize(await archive.read());
    },
  );
  // Include a late block to distinguish indexed seeking from decoding the
  // entire stream. Each selected block still starts its own decoder at zero.
  for (const offset of archive.blocks.length > 1 ? [0, archive.blocks[1]!.decodedOffset + 17] : [0]) {
    const length = Math.min(3, expected.length - offset);
    const checked = await archive.read({ offset, length });
    const prefix = await archive.read({ offset, length, verify: false });
    const oracle = expected.subarray(offset, offset + length);
    expectBytes(checked.bytes, oracle, `xz/${name}/${offset}/checked-oracle`);
    expectBytes(prefix.bytes, oracle, `xz/${name}/${offset}/prefix-oracle`);
    const native = () => decoded.slice(offset, offset + length).arrayBuffer();
    expectBytes(new Uint8Array(await native()), oracle, `xz/${name}/${offset}/native-copy-oracle`);
    if (checked.checks.length !== 1 || checked.work.outputBytes !== length || prefix.work.outputBytes !== length) {
      throw new Error("XZ benchmark selected-block or output accounting changed.");
    }
    const range = `${label} offset=${offset}B output=${length}B`;
    bench(`${range} native decoded Blob copy integrity=none`, async () => {
      do_not_optimize(await native());
    });
    bench(
      `${range} warm prefix source=${prefix.work.sourceBytes}B work=${prefix.work.decodedBytes}B termination=${
        prefix.checks[0]!.decoding
      }`,
      async () => {
        do_not_optimize(await archive.read({ offset, length, verify: false }));
      },
    );
    bench(
      `${range} warm selected-block verification source=${checked.work.sourceBytes}B work=${checked.work.decodedBytes}B check=${archive.check}`,
      async () => {
        do_not_optimize(await archive.read({ offset, length }));
      },
    );
  }
}
await report();
