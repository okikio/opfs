import { bench, do_not_optimize } from "mitata";
import { decodeBase64 } from "@std/encoding/base64";
import { createBlobSource } from "../src/source.ts";
import { openFits } from "../src/dataset/fits.ts";
import { expectBytes, report } from "./result.ts";
import receipt from "../tests/fixtures/fits/independent.json" with { type: "json" };

// Compare selected numeric decoding with a preindexed native Blob byte copy.
// The baseline does not parse headers, decode big-endian values, mask or verify.
const fixture = receipt.fixtures.find((item) => item.producer === "astropy")!;
const raw = decodeBase64(fixture.file.base64);
const blob = new Blob([new Uint8Array(raw).buffer]), source = createBlobSource(blob);
const dataset = await openFits(source, {
  maxSourceBytes: 64 * 1024 ** 3,
  maxDecodedBytes: 64 * 1024 ** 3,
  maxOutputBytes: 1024 ** 3,
  maxRequests: 10_000_000,
});
for (const image of fixture.images) {
  const result = await dataset.read(image.id);
  expectBytes(
    new Uint8Array(result.values.buffer),
    decodeBase64(image.nativeLittleEndian.base64),
    `fits/${image.id}/complete-original`,
  );
  const verified = await dataset.verify(image.id);
  if (verified.datasum !== "verified" || verified.checksum !== "verified") {
    throw new Error("FITS native checksum preflight failed.");
  }
}
const context = `fits image=${raw.length}B hdus=${dataset.hdus.length}`;
const cold = await openFits(source);
bench(`${context} cold index source=${cold.work.sourceBytes}B requests=${cold.work.requests} output=0B`, async () => {
  do_not_optimize(await openFits(source));
});
const hdu = dataset.hdus[7]!, image = fixture.images[7]!;
const original = decodeBase64(image.nativeLittleEndian.base64);
for (const count of [16, hdu.elements]) {
  const width = 2, offset = count === 16 ? 65533 : 0;
  const result = await dataset.read(hdu.id, { offset, count });
  const wanted = original.subarray(offset * width, (offset + count) * width);
  expectBytes(new Uint8Array(result.values.buffer), wanted, "fits/selected/preflight");
  const native = () =>
    blob.slice(hdu.dataOffset + offset * width, hdu.dataOffset + (offset + count) * width).arrayBuffer();
  expectBytes(
    new Uint8Array(await native()),
    raw.subarray(hdu.dataOffset + offset * width, hdu.dataOffset + (offset + count) * width),
    "fits/native-wire/preflight",
  );
  const label =
    `${context} elements=${count} offset=${offset} source=${result.work.sourceBytes}B requests=${result.work.requests}`;
  bench(
    `${label} native Blob bytecopy output=${count * width}B integrity=none`,
    async () => do_not_optimize(await native()),
  );
  bench(
    `${label} warm raw numeric+mask output=${result.work.outputBytes}B integrity=pending`,
    async () => do_not_optimize(await dataset.read(hdu.id, { offset, count })),
  );
  bench(
    `${label} cold index+raw`,
    async () => do_not_optimize(await (await openFits(source)).read(hdu.id, { offset, count })),
  );
}
const proof = await dataset.verify(hdu.id);
bench(
  `${context} full padded-HDU checksum source=${proof.work.sourceBytes}B requests=${proof.work.requests} output=0B`,
  async () => {
    do_not_optimize(await dataset.verify(hdu.id));
  },
);
const physical = await dataset.read(1, { scale: "physical" });
expectBytes(
  new Uint8Array(physical.values.buffer),
  decodeBase64(fixture.images[1]!.physicalLittleEndian!.base64),
  "fits/physical/preflight",
);
bench(
  `${context} warm physical+mask count=4 source=${physical.work.sourceBytes}B output=${physical.work.outputBytes}B`,
  async () => {
    do_not_optimize(await dataset.read(1, { scale: "physical" }));
  },
);
await report();
