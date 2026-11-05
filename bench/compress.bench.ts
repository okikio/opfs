import { bench, do_not_optimize } from "mitata";
import { toRequestBytes } from "../src/bytes.ts";
import { createArchiveLedger } from "../src/archive/record.ts";
import { compressStream, createCompressedTar, decompressStream, readCompressedTar } from "../src/archive/compress.ts";
import { expectBytes, payload, report } from "./result.ts";

/** Producer chunks are bounded independently of Blob.stream() runtime choices. No per-pull payload allocation. */
function streamed(bytes: Uint8Array): ReadableStream<Uint8Array<ArrayBuffer>> {
  let offset = 0;
  return new ReadableStream({
    pull(controller) {
      if (offset === bytes.length) return controller.close();
      const end = Math.min(offset + 65536, bytes.length);
      controller.enqueue(toRequestBytes(bytes.subarray(offset, end)));
      offset = end;
    },
  }, { highWaterMark: 0 });
}

/** Await EOF and release the actual acquired reader; no whole-output retention in timed discard lanes. */
async function drain(source: ReadableStream<Uint8Array>): Promise<number> {
  const reader = source.getReader();
  let size = 0;
  let done = false;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) {
        done = true;
        return size;
      }
      size += next.value.length;
    }
  } finally {
    try {
      if (!done) await reader.cancel();
    } finally {
      reader.releaseLock();
    }
  }
}

// The native baseline omits producer/decoded budgets, explicit lifetime joining,
// output slicing and independent gzip/zlib checksum checks. This measures those
// policy costs, not equivalent security guarantees or a competitor speed claim.
const bytes = payload(65536); // Deterministic 251-byte period; deliberately compressible, not a corpus-wide claim.
for (const format of ["gzip", "deflate", "deflate-raw"] as const) {
  const native = () => streamed(bytes).pipeThrough(new CompressionStream(format));
  const nativeEncoded = new Uint8Array(await new Response(native()).arrayBuffer());
  const encodeLedger = createArchiveLedger();
  const encoded = new Uint8Array(
    await new Response(compressStream(streamed(bytes), format, { ledger: encodeLedger })).arrayBuffer(),
  );
  const nativeDecoded = new Uint8Array(
    await new Response(streamed(encoded).pipeThrough(new DecompressionStream(format))).arrayBuffer(),
  );
  expectBytes(nativeDecoded, bytes, `compress/${format}/native-oracle`);
  const decodeLedger = createArchiveLedger();
  const decoded = new Uint8Array(
    await new Response(decompressStream(streamed(encoded), format, { ledger: decodeLedger })).arrayBuffer(),
  );
  expectBytes(decoded, bytes, `compress/${format}/bounded-oracle`);
  expectBytes(
    new Uint8Array(await new Response(decompressStream(streamed(nativeEncoded), format)).arrayBuffer()),
    bytes,
    `compress/${format}/native-encoded-oracle`,
  );
  if (await drain(native()) !== nativeEncoded.length) {
    throw new Error("Native compression length differs from bounded writer.");
  }
  const inputWork = encodeLedger.inspect();
  const outputWork = decodeLedger.inspect();
  if (
    inputWork.sourceBytes !== bytes.length || inputWork.outputBytes !== encoded.length ||
    outputWork.sourceBytes !== encoded.length || outputWork.decodedBytes !== bytes.length
  ) {
    throw new Error("Compression benchmark work counts differ from complete byte oracles.");
  }
  bench(
    `compress/${format} native encode: plain=${bytes.length}B encoded=${nativeEncoded.length}B feed=65536B`,
    async () => {
      do_not_optimize(await drain(native()));
    },
  );
  bench(
    `compress/${format} bounded encode: source=${inputWork.sourceBytes}B decoded=${inputWork.decodedBytes}B output=${inputWork.outputBytes}B`,
    async () => {
      do_not_optimize(await drain(compressStream(streamed(bytes), format)));
    },
  );
  bench(`compress/${format} native decode: compressed=${encoded.length}B plain=${bytes.length}B`, async () => {
    do_not_optimize(await drain(streamed(encoded).pipeThrough(new DecompressionStream(format))));
  });
  bench(
    `compress/${format} bounded decode: source=${outputWork.sourceBytes}B decoded=${outputWork.decodedBytes}B output=${outputWork.outputBytes}B`,
    async () => {
      do_not_optimize(await drain(decompressStream(streamed(encoded), format)));
    },
  );
}

const tarPayload = payload(1024 * 1024);
const write = () =>
  createCompressedTar([{ name: "payload.bin", size: tarPayload.length, body: streamed(tarPayload) }], "gzip");
const tarEncoded = new Uint8Array(await new Response(write()).arrayBuffer());
let visible = 0;
const scan = await readCompressedTar(streamed(tarEncoded), "gzip", async (_entry, body) => {
  for await (const chunk of body) {
    expectBytes(chunk, tarPayload.subarray(visible, visible + chunk.length), "compress/tar-payload-oracle");
    visible += chunk.length;
  }
});
if (
  !scan.complete || !scan.compression.complete || scan.compression.integrity !== "gzip-crc32" ||
  visible !== tarPayload.length
) {
  throw new Error("Compressed TAR benchmark must finish every payload byte and the gzip footer.");
}
bench(`compress/TAR gzip write + discard: payload=${tarPayload.length}B encoded=${tarEncoded.length}B`, async () => {
  do_not_optimize(await drain(write()));
});
bench(
  `compress/TAR gzip list + footer: source=${scan.compression.work.sourceBytes}B decoded=${scan.compression.work.decodedBytes}B TAR-payload-discard=${tarPayload.length}B`,
  async () => {
    do_not_optimize(await readCompressedTar(streamed(tarEncoded), "gzip", () => {}));
  },
);

await report();
