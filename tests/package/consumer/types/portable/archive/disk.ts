/** Compile-only installed archive disk contracts; never execute these expressions. */
import { openIso } from "@okikio/opfs/archive/iso";
import { openWim } from "@okikio/opfs/archive/wim";
import { openUdf } from "@okikio/opfs/archive/udf";
import { createByteSource } from "@okikio/opfs/source";

const udf: import("@okikio/opfs/archive/udf").UdfArchiveType = await openUdf(createByteSource(new Uint8Array()));
const udfRead: import("@okikio/opfs/archive/udf").UdfReadType = await udf.read(0, { length: 1 });
const udfMember: import("@okikio/opfs/source").ByteSourceType = udf.member(0);
void udfRead;
void udfMember;
const iso = await openIso(createByteSource(new Uint8Array()));
const isoParents: import("@okikio/opfs/archive/iso").IsoParentMismatchType[] = [...iso.parents.mismatches];
const wim = await openWim(createByteSource(new Uint8Array()), { subtle: globalThis.crypto.subtle });
const wimProfile: "uncompressed-1.13" | "xpress-huffman-32k-1.13" | "lzx-32k-1.13" = wim.profile;
const wimImage: import("@okikio/opfs/archive/wim").WimImageViewType = await wim.image(1);
void wimProfile;
void wimImage;
void isoParents;
