/** Compile-only installed archive records contracts; never execute these expressions. */
import { openWarc } from "@okikio/opfs/archive/warc";
import { openMime } from "@okikio/opfs/archive/mime";
import { openMbox } from "@okikio/opfs/archive/mbox";
import { openArc } from "@okikio/opfs/archive/arc";
import { createByteSource } from "@okikio/opfs/source";

const warc = await openWarc(createByteSource(new Uint8Array()));
const readable: boolean = warc.entries[0]!.readable;
const mime = await openMime(createByteSource(new Uint8Array()));
const mimeComplete: boolean = (await mime.prefix(0, 1)).complete;
const mbox = await openMbox(createByteSource(new Uint8Array()), { dialect: "mboxrd" });
const mboxSource = (await mbox.openMessage(0, { trailing: "preserve" })).source;
const arc = await openArc(createByteSource(new Uint8Array()));
const arcFormat: "internet-archive-arc" = arc.format;
void arcFormat;
void readable;
void mimeComplete;
void mboxSource;
