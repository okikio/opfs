/** Compile-only installed archive compression contracts; never execute these expressions. */
import { createLz4Decoder } from "@okikio/opfs/archive/lz4";
import { createLzmaDecoder } from "@okikio/opfs/archive/lzma";
import { createBzipDecoder } from "@okikio/opfs/archive/bzip";
import { openXz } from "@okikio/opfs/archive/xz";
import { createByteSource } from "@okikio/opfs/source";
import { createCompressedTar, scanCompressedTar } from "@okikio/opfs/archive/compress";

const lz4 = createLz4Decoder(new Blob().stream());
const finished: Promise<import("@okikio/opfs/archive/lz4").Lz4ResultType> = lz4.finished;
void finished;
const xz: import("@okikio/opfs/archive/xz").XzArchiveType = await openXz(createByteSource(new Uint8Array()));
const xzRead: import("@okikio/opfs/archive/xz").XzReadType = await xz.read({ length: 1 });
void xzRead;
const bzip: import("@okikio/opfs/archive/bzip").BzipDecoderType = createBzipDecoder(createByteSource(new Uint8Array()));
const bzipEnd: import("@okikio/opfs/archive/bzip").BzipResultType = await bzip.finished;
void bzipEnd;
const lzma: import("@okikio/opfs/archive/lzma").LzmaDecoderType = createLzmaDecoder(
  createByteSource(new Uint8Array()),
  { format: "raw-lzma2", dictionary: 8 },
);
const lzmaEnd: import("@okikio/opfs/archive/lzma").LzmaResultType = await lzma.finished;
void lzmaEnd;
const compressedTar = createCompressedTar([{ name: "typed", size: 0 }], "gzip");
const result = await scanCompressedTar(compressedTar, "gzip", () => {});
const integrity: string = result.compression.integrity;
void integrity;
