/** Compile-only installed dataset bam contracts; never execute these expressions. */
import { openBam } from "@okikio/opfs/dataset/bam";
import { createByteSource } from "@okikio/opfs/source";

const bamOptionsTyped: import("@okikio/opfs/dataset/bam").BamOptionsType = {
  maxHeaderBytes: 1024,
  maxRecordBytes: 1024,
  maxTotalRecords: 16,
  maxDeflateBlocks: 256,
};
const bamTyped: import("@okikio/opfs/dataset/bam").BamDatasetType = await openBam(
  createByteSource(new Uint8Array()),
  bamOptionsTyped,
);
const bamPagesTyped: AsyncGenerator<import("@okikio/opfs/dataset/bam").BamPageType> = bamTyped.records({
  maxRecords: 20,
  pageRecords: 10,
});
const bamRecordTyped: import("@okikio/opfs/dataset/bam").BamRecordType | undefined = (await bamPagesTyped.next()).value
  ?.records[0];
const bamOffsetTyped: bigint | undefined = bamRecordTyped?.virtualOffset;
// @ts-expect-error Preview counts are finite numeric selections, never textual offsets.
bamTyped.records({ maxRecords: "20" });
void bamOffsetTyped;
void bamTyped.header.references;
void bamTyped.inspect();
