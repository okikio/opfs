import { bench, do_not_optimize } from "mitata";
import { createBlobSource } from "../src/source.ts";
import { openZip } from "../src/archive/zip.ts";
import { createZipStream } from "../src/archive/write.ts";
import type { ZipWriteEntryType } from "../src/archive/write.ts";
import { expectBytes, report } from "./result.ts";

/** Independent Python binascii CRC32 results for all-A payloads at these sizes. */
const cases = [[1024, 3073899290], [65536, 2694514304], [4194304, 2772904712]] as const;

/** Single stored-member fixture. Setup stays outside warm read measurements. */
function fixture(size: number, crc: number): Uint8Array {
  const name = new TextEncoder().encode("payload.bin");
  const local = 30 + name.length;
  const directory = local + size;
  const bytes = new Uint8Array(directory + 46 + name.length + 22);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, 0x04034b50, true);
  view.setUint16(4, 20, true);
  view.setUint32(14, crc, true);
  view.setUint32(18, size, true);
  view.setUint32(22, size, true);
  view.setUint16(26, name.length, true);
  bytes.set(name, 30);
  bytes.fill(65, local, directory);
  view.setUint32(directory, 0x02014b50, true);
  view.setUint16(directory + 4, 20, true);
  view.setUint16(directory + 6, 20, true);
  view.setUint32(directory + 16, crc, true);
  view.setUint32(directory + 20, size, true);
  view.setUint32(directory + 24, size, true);
  view.setUint16(directory + 28, name.length, true);
  bytes.set(name, directory + 46);
  const end = directory + 46 + name.length;
  view.setUint32(end, 0x06054b50, true);
  view.setUint16(end + 8, 1, true);
  view.setUint16(end + 10, 1, true);
  view.setUint32(end + 12, 46 + name.length, true);
  view.setUint32(end + 16, directory, true);
  return bytes;
}

// This suite asks how indexing, checksum work and output copying change the
// cost of a 1 KiB preview. It makes no competitor or cache-locality claim.
for (const [size, crc] of cases) {
  const blob = new Blob([new Uint8Array(fixture(size, crc)).buffer]);
  const source = createBlobSource(blob);
  // Repeated samples share one index; its lifetime allowance is finite and explicit.
  const archive = await openZip(source, {
    maxSourceBytes: 64 * 1024 ** 3,
    maxDecodedBytes: 64 * 1024 ** 3,
    maxOutputBytes: 64 * 1024 ** 3,
    maxRequests: 100000000,
  });
  const length = Math.min(1024, size);
  const expected = new Uint8Array(length).fill(65);
  const preview = await archive.read(0, { length });
  expectBytes(preview.bytes, expected, "archive/warm-prefix");
  expectBytes((await archive.read(0)).bytes, new Uint8Array(size).fill(65), "archive/full-verify");
  const dataOffset = 30 + new TextEncoder().encode("payload.bin").length;
  bench(`archive/${size} bytes: native Blob slice 1 KiB`, async () => {
    do_not_optimize(await blob.slice(dataOffset, dataOffset + length).arrayBuffer());
  });
  bench(`archive/${size} bytes: cold ZIP index + 1 KiB prefix`, async () => {
    const opened = await openZip(source);
    do_not_optimize(await opened.read(0, { length }));
  });
  bench(`archive/${size} bytes: warm ZIP 1 KiB prefix`, async () => {
    do_not_optimize(await archive.read(0, { length }));
  });
  bench(`archive/${size} bytes: full ZIP CRC verification`, async () => {
    do_not_optimize(await archive.read(0));
  });
}

/** Count output without retaining it; the caller still awaits EOF and each reader release. */
async function drain(source: ReadableStream<Uint8Array>): Promise<number> {
  const reader = source.getReader();
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) return total;
      total += next.value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }
}

/** One stable 64 KiB input buffer models producer memory independent of logical member length. */
function streamed(size: number): ReadableStream<Uint8Array> {
  const chunk = new Uint8Array(Math.min(size, 65536)).fill(65);
  let remaining = size;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (remaining === 0) controller.close();
      else {
        const length = Math.min(remaining, chunk.byteLength);
        remaining -= length;
        controller.enqueue(chunk.subarray(0, length));
      }
    },
  }, { highWaterMark: 0 });
}

// These lanes ask what CRC/ZIP framing and output materialization add to a
// bounded stream drain. The bytes-only lane deliberately does not produce ZIP;
// it is an I/O baseline, not an equivalent archive implementation or speed claim.
for (const [size, crc] of cases) {
  const input = new Uint8Array(size).fill(65);
  const write = () => createZipStream([{ name: "payload.bin", source: streamed(size) }]);
  const collected = new Uint8Array(await new Response(write()).arrayBuffer());
  const opened = await openZip(createBlobSource(new Blob([collected.buffer])));
  if (opened.entries.length !== 1 || opened.entries[0]!.crc32 !== crc || opened.entries[0]!.size !== size) {
    throw new Error("ZIP writer benchmark differs from the independent CRC/extent oracle.");
  }
  expectBytes((await opened.read(0, { verify: true })).bytes, input, "archive/write-stream/oracle");
  if (await drain(write()) !== collected.byteLength) {
    throw new Error("ZIP benchmark drain did not reach the full end record.");
  }

  bench(`archive/write/${size} bytes: Web payload drain (no ZIP or CRC)`, async () => {
    do_not_optimize(await drain(streamed(size)));
  });
  bench(`archive/write/${size} bytes: STORED stream + CRC, discard output`, async () => {
    do_not_optimize(await drain(write()));
  });
  bench(`archive/write/${size} bytes: STORED stream + CRC, collect output`, async () => {
    do_not_optimize(await new Response(write()).arrayBuffer());
  });
  bench(`archive/write/${size} bytes: STORED materialized input + CRC, discard output`, async () => {
    do_not_optimize(await drain(createZipStream([{ name: "payload.bin", source: input }])));
  });
}

/** Same payload per entry keeps directory cardinality separate from total stored bytes. */
function* smallEntries(count: number): Generator<ZipWriteEntryType> {
  const bytes = new Uint8Array(128).fill(65);
  for (let index = 0; index < count; index++) {
    yield { name: `items/${String(index).padStart(5, "0")}.bin`, source: bytes };
  }
}
for (const count of [1, 1024, 10000]) {
  const bytes = new Uint8Array(await new Response(createZipStream(smallEntries(count))).arrayBuffer());
  const archive = await openZip(createBlobSource(new Blob([bytes.buffer])));
  if (
    archive.entries.length !== count || archive.entries.some((entry) => entry.size !== 128 || entry.crc32 !== 68717278)
  ) {
    // 68717278 is the independent Python binascii CRC32 of 128 ASCII A bytes.
    throw new Error("ZIP directory workload lost an entry, extent or CRC.");
  }
  expectBytes(
    (await archive.read(count - 1, { verify: true })).bytes,
    new Uint8Array(128).fill(65),
    "archive/write-many/oracle",
  );
  bench(`archive/write/${count} entries of 128 bytes: STORED directory + payload, discard output`, async () => {
    do_not_optimize(await drain(createZipStream(smallEntries(count))));
  });
}

bench("archive/write: first local header + cancel (no payload acquisition)", async () => {
  const reader = createZipStream([{ name: "payload.bin", source: streamed(4194304) }]).getReader();
  try {
    do_not_optimize(await reader.read());
    await reader.cancel();
  } finally {
    reader.releaseLock();
  }
});

await report();
