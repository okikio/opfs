/** Compile-only installed content arfs contracts; never execute these expressions. */
import { openArfs } from "@okikio/opfs/content/arfs";
import { createByteSource } from "@okikio/opfs/source";

const arfsInput: import("@okikio/opfs/content/arfs").ArfsInputType = {
  drive: {
    transactionId: "id",
    owner: "owner",
    tags: [],
    source: createByteSource(new Uint8Array(), { identity: "explicit" }),
  },
  entities: [],
};
const arfs: import("@okikio/opfs/content/arfs").ArfsViewType = await openArfs(arfsInput);
const arfsFile: import("@okikio/opfs/content/arfs").ArfsFileType = arfs.file("uuid");
const arfsRead: import("@okikio/opfs/content/arfs").ArfsReadType = await arfsFile.read({
  transactionId: "data",
  source: createByteSource(new Uint8Array(), { identity: "explicit-data" }),
});
void arfsRead;
