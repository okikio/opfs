/** Compile-only installed dataset mcap contracts; never execute these expressions. */
import { openMcap } from "@okikio/opfs/dataset/mcap";
import { createByteSource } from "@okikio/opfs/source";

const mcapTyped: import("@okikio/opfs/dataset/mcap").McapFileType = await openMcap(createByteSource(new Uint8Array()), {
  profile: "mcap0-uncompressed",
});
const mcapPageTyped: import("@okikio/opfs/dataset/mcap").McapPageType = mcapTyped.messages({
  startLogTime: 9007199254740993n,
});
const mcapReadTyped: import("@okikio/opfs/dataset/mcap").McapReadType = await mcapTyped.read(0, { length: 3 });
void mcapPageTyped;
void mcapReadTyped;
