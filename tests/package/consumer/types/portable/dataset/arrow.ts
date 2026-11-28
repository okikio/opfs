/** Compile-only installed dataset arrow contracts; never execute these expressions. */
import { openArrow, readArrow } from "@okikio/opfs/dataset/arrow";
import { createByteSource } from "@okikio/opfs/source";

const arrowOptionsTyped: import("@okikio/opfs/dataset/arrow").ArrowOpenOptionsType = {
  maxMetadataBytes: 1024,
  maxBufferBytes: 1024,
  maxSelectedBytes: 2048,
  maxRows: 16,
  maxOutputBytes: 4096,
};
const arrowTyped: import("@okikio/opfs/dataset/arrow").ArrowDatasetType = await openArrow(
  createByteSource(new Uint8Array()),
  arrowOptionsTyped,
);
const arrowReadTyped: import("@okikio/opfs/dataset/arrow").ArrowReadType = await arrowTyped.read(0, [0]);
const arrowColumnTyped: import("@okikio/opfs/dataset/arrow").ArrowColumnType | undefined = arrowReadTyped.columns[0];
const arrowIntegrityTyped: "none" = arrowReadTyped.integrity;
const arrowStreamOptionsTyped: import("@okikio/opfs/dataset/arrow").ArrowStreamOptionsType = {
  columns: [0],
  maxChunkBytes: 65536,
};
const arrowStreamTyped: AsyncGenerator<import("@okikio/opfs/dataset/arrow").ArrowStreamBatchType> = readArrow(
  new ReadableStream<Uint8Array>(),
  arrowStreamOptionsTyped,
);
void arrowColumnTyped;
void arrowIntegrityTyped;
void arrowStreamTyped;
