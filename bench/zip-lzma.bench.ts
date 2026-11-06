import { bench, do_not_optimize } from "mitata";
import { decodeBase64 } from "@std/encoding/base64";
import { openZip } from "../src/archive/zip.ts";
import { createLzmaDecoder } from "../src/archive/lzma.ts";
import { createBlobSource } from "../src/source.ts";
import { expectBytes, report } from "./result.ts";
import fixtures from "../tests/fixtures/zip-lzma/independent.json" with { type: "json" };

// Native-produced bytes and original arrays are preflight oracles. These lanes
// separate plaintext copying, metadata, raw LZMA1 and ZIP verification work.
// Warm archives have finite aggregate sampling allowances, with per-read defaults.
for (const profile of ["seven-64k", "python"]) {
  const fixture = fixtures.fixtures.find((item) => item.name === profile)!;
  const member = fixture.members.find((item) => item.name === "many.bin")!;
  const original = decodeBase64(member.original.base64), raw = decodeBase64(fixture.archive.base64);
  const body = new Blob([new Uint8Array(original).buffer]);
  const source = createBlobSource(new Blob([new Uint8Array(raw).buffer]));
  const properties = raw.slice(member.offset + 4, member.offset + 9);
  const packed = createBlobSource(
    new Blob([
      new Uint8Array(raw.slice(member.offset + 9, member.offset + member.compressedSize)).buffer,
    ]),
  );
  const decode = () =>
    createLzmaDecoder(packed, {
      format: "raw-lzma1",
      properties,
      size: original.length,
      marker: "required",
    });
  const decoder = decode();
  expectBytes(new Uint8Array(await new Response(decoder.stream).arrayBuffer()), original, "zip-lzma/raw-native-oracle");
  await decoder.finished;
  const archive = await openZip(source, {
    maxSourceBytes: 64 * 1024 ** 3,
    maxDecodedBytes: 64 * 1024 ** 3,
    maxOutputBytes: 64 * 1024 ** 3,
    maxRequests: 100000000,
  });
  const id = archive.entries.find((entry) => entry.name === member.name)!.id, length = 1024;
  const full = await archive.read(id), prefix = await archive.read(id, { length });
  const verified = await archive.read(id, { length, verify: true });
  expectBytes(full.bytes, original, "zip-lzma/full");
  expectBytes(prefix.bytes, original.subarray(0, length), "zip-lzma/prefix");
  expectBytes(verified.bytes, original.subarray(0, length), "zip-lzma/verified-prefix");
  expectBytes(
    new Uint8Array(await body.slice(0, length).arrayBuffer()),
    original.subarray(0, length),
    "zip-lzma/byte-baseline",
  );
  const metrics = (work: typeof full.work): string =>
    `source=${work.sourceBytes}B requests=${work.requests} decoded=${work.decodedBytes}B output=${work.outputBytes}B`;
  const label = `zip-lzma/${profile} packed=${member.compressedSize}B plain=${original.length}B dict=${
    member.wire!.dictionaryBytes
  }B`;
  bench(`${label}: native Blob plaintext prefix (no decode)`, async () => {
    do_not_optimize(await body.slice(0, length).arrayBuffer());
  });
  bench(`${label}: cold ZIP index`, async () => {
    do_not_optimize(await openZip(source));
  });
  bench(`${label}: pure raw LZMA1 verified-termination drain`, async () => {
    const decoder = decode(), reader = decoder.stream.getReader();
    let bytes = 0;
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        bytes += next.value.length;
      }
      await decoder.finished;
      do_not_optimize(bytes);
    } finally {
      reader.releaseLock();
    }
  });
  bench(`${label}: warm prefix pending ${metrics(prefix.work)}`, async () => {
    do_not_optimize(await archive.read(id, { length }));
  });
  bench(`${label}: warm verified prefix ${metrics(verified.work)}`, async () => {
    do_not_optimize(await archive.read(id, { length, verify: true }));
  });
  bench(`${label}: warm full CRC ${metrics(full.work)}`, async () => {
    do_not_optimize(await archive.read(id));
  });
}

await report();
