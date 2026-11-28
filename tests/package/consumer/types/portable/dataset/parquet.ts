/** Compile-only installed dataset parquet contracts; never execute these expressions. */
import { openParquet } from "@okikio/opfs/dataset/parquet";
import { createByteSource } from "@okikio/opfs/source";

const parquetTyped: import("@okikio/opfs/dataset/parquet").ParquetDatasetType = await openParquet(
  createByteSource(new Uint8Array()),
  { maxRows: 16 },
);
const parquetReadTyped: import("@okikio/opfs/dataset/parquet").ParquetReadType = await parquetTyped.read(0, {
  offset: 0,
  length: 1,
});
const parquetValuesTyped: import("@okikio/opfs/dataset/parquet").ParquetValuesType = parquetReadTyped.values;
const parquetIntegrityTyped: "metadata-unverified" = parquetTyped.integrity;
void parquetValuesTyped;
void parquetIntegrityTyped;
