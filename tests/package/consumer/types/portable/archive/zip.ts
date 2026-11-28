/** Compile-only installed archive zip contracts; never execute these expressions. */
import { createZipStream } from "@okikio/opfs/archive/zip/write";
import type { ZipWriteEntryType } from "@okikio/opfs/archive/zip/write";
import { openZip } from "@okikio/opfs/archive/zip";
import { createZipAdapter } from "@okikio/opfs/view/zip";
import { createByteSource } from "@okikio/opfs/source";

const zipLzmaPolicy: import("@okikio/opfs/archive/zip").ZipLzmaOptionsType = {
  maxDictionaryBytes: 1048576,
  maxSteps: 1000000,
};
const zipCodecArchive = await openZip(createByteSource(new Uint8Array()));
const zipCodecRead = await zipCodecArchive.read(0, { lzma: zipLzmaPolicy });
if (zipCodecRead.codec?.kind === "lzma") {
  const termination: "pending" | "end-marker" = zipCodecRead.codec.termination;
  void termination;
}
const zipCodecView: import("@okikio/opfs/view/zip").ZipViewOptionsType = {
  lzma: zipLzmaPolicy,
  bzip: { maxMemoryBytes: 8388608 },
  maxOutputBytes: 1024,
};
void createZipAdapter(zipCodecArchive, zipCodecView);
const passwordOptions = { password: new Uint8Array(), verify: true };
void passwordOptions;
const zipEntry: ZipWriteEntryType = { name: "typed", size: 0 };
const zipBytes = new Uint8Array(await new Response(createZipStream([zipEntry])).arrayBuffer());
const zip = await openZip(createByteSource(zipBytes));
const member: Uint8Array = (await zip.read(0)).bytes;
void member;
