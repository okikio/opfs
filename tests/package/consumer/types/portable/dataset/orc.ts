/** Compile-only installed dataset orc contracts; never execute these expressions. */
import { openOrc } from "@okikio/opfs/dataset/orc";
import { createByteSource } from "@okikio/opfs/source";

const orcTyped: import("@okikio/opfs/dataset/orc").OrcDatasetType = await openOrc(createByteSource(new Uint8Array()), {
  maxRows: 16,
});
const orcReadTyped: import("@okikio/opfs/dataset/orc").OrcReadType = await orcTyped.read(0, { length: 1 });
void orcReadTyped;
