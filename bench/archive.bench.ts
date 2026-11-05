import { bench, do_not_optimize } from "mitata";
import { createBlobSource } from "../src/source.ts";
import { openZip } from "../src/archive/zip.ts";
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
  const archive = await openZip(source);
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

await report();
