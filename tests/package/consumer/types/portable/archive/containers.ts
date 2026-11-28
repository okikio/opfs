import { openRar } from "@okikio/opfs/archive/rar";
/** Compile-only installed archive containers contracts; never execute these expressions. */
import { openCpio } from "@okikio/opfs/archive/cpio";
import { createCpioAdapter } from "@okikio/opfs/view/cpio";
import { openCab } from "@okikio/opfs/archive/cab";
import { openSeven } from "@okikio/opfs/archive/seven";
import { openAr } from "@okikio/opfs/archive/ar";
import { openXar } from "@okikio/opfs/archive/xar";
import { openLha } from "@okikio/opfs/archive/lha";
import { openArj } from "@okikio/opfs/archive/arj";
import { openBinHex } from "@okikio/opfs/archive/binhex";
import { createByteSource } from "@okikio/opfs/source";

const cpioView = createCpioAdapter(await openCpio(createByteSource(new Uint8Array())));
void cpioView;
const cab = await openCab(createByteSource(new Uint8Array()));
const cabRole: "covering" | "history" | undefined = (await cab.read(0)).blocks[0]?.role;
const cabDeflateBlocks: number = (await cab.read(0, { maxDeflateBlocks: 8192 })).deflateBlocks;
void cabRole;
void cabDeflateBlocks;
const seven = await openSeven(createByteSource(new Uint8Array()));
const sevenReadable: boolean = seven.entries[0]!.readable;
const sevenCodecPolicy: import("@okikio/opfs/archive/seven").SevenLzmaOptionsType = { maxDictionaryBytes: 65536 };
const sevenHeader: string | undefined = seven.headers.decoded?.method;
const sevenDecoding: "complete" | "prefix" | undefined = (await seven.read(0, { lzma: sevenCodecPolicy })).decoding;
void sevenHeader;
void sevenDecoding;
const ar = await openAr(createByteSource(new Uint8Array()));
const arSource = ar.member(0);
const lhaTyped: import("@okikio/opfs/archive/lha").LhaArchiveType = await openLha(createByteSource(new Uint8Array()));
const lhaTypedRead: import("@okikio/opfs/archive/lha").LhaReadType = await lhaTyped.read(0, {
  verify: false,
  length: 1,
});
const arjTyped: import("@okikio/opfs/archive/arj").ArjArchiveType = await openArj(createByteSource(new Uint8Array()));
const arjTypedRead: import("@okikio/opfs/archive/arj").ArjReadType = await arjTyped.read(0, {
  verify: false,
  length: 1,
});
const arjTypedSource: import("@okikio/opfs/source").ByteSourceType = arjTyped.member(0);
void arjTypedRead;
void arjTypedSource;
const binhexTyped: import("@okikio/opfs/archive/binhex").BinHexArchiveType = await openBinHex(
  createByteSource(new Uint8Array()),
);
const binhexReadTyped: import("@okikio/opfs/archive/binhex").BinHexReadType = await binhexTyped.read("data");
void binhexReadTyped;
void lhaTypedRead;
const xar = await openXar(createByteSource(new Uint8Array()), { verifyToc: false });
const xarStatus: import("@okikio/opfs/archive/xar").XarChecksumStatusType = xar.toc.status;
void xarStatus;
void cab;
void sevenReadable;
void arSource;

// Retain the original named-export declaration check even without a call-site assertion.
void openRar;
