import { bench, do_not_optimize } from "mitata";
import { decodeBase64 } from "@std/encoding/base64";
import { openZip } from "../src/archive/zip.ts";
import { createBzipDecoder } from "../src/archive/bzip.ts";
import { createBlobSource } from "../src/source.ts";
import { expectBytes, report } from "./result.ts";
import fixtures from "../tests/fixtures/zip-bzip/independent.json" with { type: "json" };

/** Drain the pure codec without retaining plaintext; callers observe its terminal checks and release the reader. */
async function decode(source: ReturnType<typeof createBlobSource>): Promise<number> {
  const decoder = createBzipDecoder(source), reader = decoder.stream.getReader();
  let size = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.length;
    }
    await decoder.finished;
    return size;
  } finally {
    reader.releaseLock();
  }
}

// These lanes separate metadata, plaintext-copy baseline, pure BZip2 and ZIP work.
// Each cold operation gets fresh policy. Warm samples share finite opening
// allowances; per-read defaults remain unchanged. No cross-runtime speed claim.
for (const level of [1, 9]) {
  const fixture = fixtures.fixtures.find((item) => item.name === `python-${level}`)!;
  const member = fixture.members.find((item) => item.name === "many.bin")!;
  const original = decodeBase64(member.original.base64), raw = decodeBase64(fixture.archive.base64);
  const body = new Blob([new Uint8Array(original).buffer]);
  const source = createBlobSource(new Blob([new Uint8Array(raw).buffer]));
  const packed = createBlobSource(
    new Blob([new Uint8Array(raw.slice(member.offset, member.offset + member.compressedSize)).buffer]),
  );
  const archive = await openZip(source, {
    maxSourceBytes: 64 * 1024 ** 3,
    maxDecodedBytes: 64 * 1024 ** 3,
    maxOutputBytes: 64 * 1024 ** 3,
    maxRequests: 100000000,
  });
  const id = archive.entries.find((entry) => entry.name === member.name)!.id;
  const length = 1024;
  const full = await archive.read(id);
  expectBytes(full.bytes, original, "zip-bzip/full");
  const prefix = await archive.read(id, { length });
  expectBytes(prefix.bytes, original.subarray(0, length), "zip-bzip/prefix");
  const verified = await archive.read(id, { length, verify: true });
  expectBytes(verified.bytes, original.subarray(0, length), "zip-bzip/verified-prefix");
  const decoder = createBzipDecoder(packed);
  const plain = new Uint8Array(await new Response(decoder.stream).arrayBuffer());
  await decoder.finished;
  expectBytes(plain, original, "zip-bzip/native-produced-raw-codec");
  expectBytes(
    new Uint8Array(await body.slice(0, length).arrayBuffer()),
    original.subarray(0, length),
    "zip-bzip/byte-baseline",
  );
  if (await decode(packed) !== original.length) throw new Error("BZip2 drain lost original bytes.");
  const metrics = (work: typeof full.work): string =>
    `source=${work.sourceBytes}B requests=${work.requests} decoded=${work.decodedBytes}B output=${work.outputBytes}B`;
  const label = `zip-bzip/BZh${level} packed=${member.compressedSize}B plain=${original.length}B`;
  bench(`${label}: native Blob plaintext prefix (no decode)`, async () => {
    do_not_optimize(await body.slice(0, length).arrayBuffer());
  });
  bench(`${label}: cold ZIP index`, async () => {
    do_not_optimize(await openZip(source));
  });
  bench(`${label}: pure BZip2 full verified drain`, async () => {
    do_not_optimize(await decode(packed));
  });
  bench(`${label}: warm prefix pending ${metrics(prefix.work)}`, async () => {
    do_not_optimize(await archive.read(id, { length }));
  });
  bench(`${label}: warm verified prefix ${metrics(verified.work)}`, async () => {
    do_not_optimize(await archive.read(id, { length, verify: true }));
  });
  bench(`${label}: warm full verified ${metrics(full.work)}`, async () => {
    do_not_optimize(await archive.read(id));
  });
}

await report();
