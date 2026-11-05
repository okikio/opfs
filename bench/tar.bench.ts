import { bench, do_not_optimize } from "mitata";
import { decodeBase64 } from "@std/encoding/base64";
import { createBlobSource } from "../src/source.ts";
import { createArchiveLedger, openTar } from "../src/archive/tar.ts";
import { createTarStream, readTarStream } from "../src/archive/stream.ts";
import type { ArchiveWorkType } from "../src/archive/record.ts";
import { expectBytes, payload, report } from "./result.ts";
import fixtures from "../tests/fixtures/tar/independent.json" with { type: "json" };
import sparseFixtures from "../tests/fixtures/tar-sparse/independent.json" with { type: "json" };

// Warm indexed readers retain their opening admission owner. Repeated sampling
// therefore needs an explicit finite allowance rather than resetting that owner.
const samplingLimits = {
  maxSourceBytes: 64 * 1024 ** 3,
  maxDecodedBytes: 64 * 1024 ** 3,
  maxOutputBytes: 1024 ** 3,
  maxRequests: 10_000_000,
};

/** Independent Python POSIX header adapted only for the benchmark name, size and resulting checksum. */
function fixture(bytes: Uint8Array): Uint8Array {
  const header = decodeBase64(fixtures.pax.archive).slice(2048, 2560);
  const encoder = new TextEncoder();
  header.fill(0, 0, 100);
  header.set(encoder.encode("payload.bin"));
  header.set(encoder.encode(`${bytes.length.toString(8).padStart(11, "0")}\0`), 124);
  header.fill(32, 148, 156);
  const checksum = header.reduce((sum, value) => sum + value, 0);
  header.set(encoder.encode(`${checksum.toString(8).padStart(6, "0")}\0 `), 148);
  const output = new Uint8Array(512 + Math.ceil(bytes.length / 512) * 512 + 1024);
  output.set(header);
  output.set(bytes, 512);
  return output;
}

/** A fixed buffer whose length is a multiple of the payload oracle's 251-byte period. */
function streamed(size: number): ReadableStream<Uint8Array> {
  const chunk = payload(Math.min(size, 251 * 256));
  let remaining = size;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (remaining === 0) return controller.close();
      const length = Math.min(remaining, chunk.length);
      remaining -= length;
      controller.enqueue(chunk.subarray(0, length));
    },
  }, { highWaterMark: 0 });
}

/** Blob.stream() chunk sizes vary by runtime; bound producer allocation and read-ahead explicitly. */
function archiveStream(blob: Blob): ReadableStream<Uint8Array> {
  let offset = 0;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (offset === blob.size) return controller.close();
      const end = Math.min(offset + 65536, blob.size);
      const bytes = new Uint8Array(await blob.slice(offset, end).arrayBuffer());
      offset = end;
      controller.enqueue(bytes);
    },
  }, { highWaterMark: 0 });
}

/** The benchmark owns and retires its reader even if a producer fails during sampling. */
async function drain(source: ReadableStream<Uint8Array>): Promise<number> {
  const reader = source.getReader();
  let count = 0;
  let done = false;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) {
        done = true;
        return count;
      }
      count += next.value.length;
    }
  } finally {
    try {
      if (!done) await reader.cancel();
    } finally {
      reader.releaseLock();
    }
  }
}

/** Work counts are part of every raw benchmark name, not an inference from elapsed time. */
function counts(work: ArchiveWorkType): string {
  return `source=${work.sourceBytes} decoded=${work.decodedBytes} output=${work.outputBytes} requests=${work.requests}`;
}

// Workload question: what does TAR framing, indexing, sequential traversal and
// selected output cost relative to byte-only operations? These lanes do different
// work by design; byte counters expose the difference and do not imply random
// access from an ordinary stream or payload integrity from TAR header checksums.
for (const size of [1024, 65536, 4194304]) {
  const expected = payload(size);
  const archiveBytes = fixture(expected);
  const blob = new Blob([new Uint8Array(archiveBytes).buffer]);
  const source = createBlobSource(blob);
  const archive = await openTar(source, samplingLimits);
  const length = Math.min(1024, size);
  const prefix = expected.subarray(0, length);
  const selected = await archive.read(0, { length });
  expectBytes(selected.bytes, prefix, "tar/warm-prefix");
  expectBytes((await archive.read(0)).bytes, expected, "tar/full-member");
  if (archive.entries.length !== 1 || archive.entries[0]!.size !== size || archive.work.sourceBytes !== 1536) {
    throw new Error("TAR indexed benchmark must skip all member payload bytes.");
  }
  const listing = await readTarStream(archiveStream(blob), () => {});
  if (
    !listing.complete || listing.work.decodedBytes !== size || listing.work.outputBytes !== 0 ||
    listing.work.sourceBytes !== archiveBytes.length
  ) {
    throw new Error("TAR listing must account for its full consumed source and discarded payload.");
  }
  const preview = await readTarStream(archiveStream(blob), async (_entry, body) => {
    for await (const bytes of body) {
      expectBytes(bytes, prefix, "tar/stream-prefix");
      break;
    }
    return false;
  }, { bodyChunkBytes: length });
  if (preview.complete || preview.work.outputBytes !== length || preview.work.decodedBytes !== length) {
    throw new Error("TAR early preview must report only delivered payload work and incomplete traversal.");
  }
  const ledger = createArchiveLedger();
  const written = new Uint8Array(
    await new Response(createTarStream([
      { name: "payload.bin", size, body: streamed(size) },
    ], { ledger })).arrayBuffer(),
  );
  if (
    written.length !== archiveBytes.length || ledger.inspect().sourceBytes !== size ||
    ledger.inspect().outputBytes !== written.length
  ) {
    throw new Error("TAR writer must account for all source and framing bytes through EOF.");
  }
  const writtenArchive = await openTar(createBlobSource(new Blob([written.buffer])));
  expectBytes((await writtenArchive.read(0)).bytes, expected, "tar/write-stream-oracle");
  if (await drain(streamed(size)) !== size) throw new Error("Native payload baseline did not reach EOF.");

  bench(`tar/${size}B native Blob prefix: source=${length} decoded=0 output=${length}`, async () => {
    do_not_optimize(await blob.slice(512, 512 + length).arrayBuffer());
  });
  bench(`tar/${size}B cold indexed scan: ${counts(archive.work)}`, async () => {
    do_not_optimize(await openTar(source));
  });
  bench(
    `tar/${size}B cold index + prefix: source=${archive.work.sourceBytes + length} decoded=${length} output=${length}`,
    async () => {
      const opened = await openTar(source);
      do_not_optimize(await opened.read(0, { length }));
    },
  );
  bench(`tar/${size}B warm selected prefix: ${counts(selected.work)}`, async () => {
    do_not_optimize(await archive.read(0, { length }));
  });
  bench(`tar/${size}B sequential list: ${counts(listing.work)}`, async () => {
    do_not_optimize(await readTarStream(archiveStream(blob), () => {}));
  });
  bench(`tar/${size}B sequential prefix + cancel: ${counts(preview.work)}`, async () => {
    do_not_optimize(
      await readTarStream(archiveStream(blob), async (_entry, body) => {
        for await (const bytes of body) {
          do_not_optimize(bytes);
          break;
        }
        return false;
      }, { bodyChunkBytes: length }),
    );
  });
  bench(`tar/${size}B native payload drain: source=${size} decoded=0 output=${size}`, async () => {
    do_not_optimize(await drain(streamed(size)));
  });
  bench(`tar/${size}B writer + discard: ${counts(ledger.inspect())}`, async () => {
    do_not_optimize(await drain(createTarStream([{ name: "payload.bin", size, body: streamed(size) }])));
  });
}

// Genuine sparse files have a different physical layout from their logical
// bytes. The native baseline already owns a fully expanded original Blob; it
// measures copying alone, not map validation, zero reconstruction or archive I/O.
const sparseFixture = sparseFixtures.fixtures.find((item) => item.profile === "1.0")!;
const originals: Readonly<Record<string, { readonly base64: string }>> = sparseFixture.payloads;
const sparseBytes = decodeBase64(sparseFixture.archive.base64);
const sparseSource = createBlobSource(new Blob([new Uint8Array(sparseBytes).buffer]));
const sparseArchive = await openTar(sparseSource, samplingLimits);
for (const entry of sparseArchive.entries) {
  expectBytes(
    (await sparseArchive.read(entry.id)).bytes,
    decodeBase64(originals[entry.name]!.base64),
    `tar/sparse/${entry.name}/complete`,
  );
}
const coldSparse = await openTar(sparseSource);
bench(`tar/sparse image=${sparseBytes.length}B cold index ${counts(coldSparse.work)}`, async () => {
  do_not_optimize(await openTar(sparseSource));
});
for (const name of ["all-hole.bin", "leading.bin", "many.bin"]) {
  const entry = sparseArchive.entries.find((item) => item.name === name)!;
  const expected = decodeBase64(originals[name]!.base64);
  const originalBlob = new Blob([new Uint8Array(expected).buffer]);
  const first = entry.sparse!.extents.find((extent) => extent.length > 0);
  const offset = first ? Math.max(0, first.offset - 8) : 4096;
  const length = 37;
  const selected = await sparseArchive.read(entry.id, { offset, length });
  const native = () => originalBlob.slice(offset, offset + length).arrayBuffer();
  expectBytes(selected.bytes, expected.subarray(offset, offset + length), `tar/sparse/${name}/range`);
  expectBytes(new Uint8Array(await native()), expected.subarray(offset, offset + length), `tar/sparse/${name}/native`);
  if (
    selected.work.outputBytes !== length || selected.work.decodedBytes !== length ||
    name === "all-hole.bin" && (selected.work.requests !== 0 || selected.work.sourceBytes !== 0)
  ) {
    throw new Error("TAR sparse logical/physical benchmark accounting differs.");
  }
  const label = `tar/sparse ${name} logical=${entry.size}B stored=${entry.sparse!.storedSize}B offset=${offset}B`;
  bench(`${label} preexpanded native Blob source=${length}B output=${length}B requests=1 integrity=none`, async () => {
    do_not_optimize(await native());
  });
  bench(`${label} warm logical range ${counts(selected.work)} integrity=header-checksum-only`, async () => {
    do_not_optimize(await sparseArchive.read(entry.id, { offset, length }));
  });
}
await report();
