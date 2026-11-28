/** Compile-only installed archive tar contracts; never execute these expressions. */
import { createTarStream, scanTar } from "@okikio/opfs/archive/tar/stream";
import type { TarWriteEntryType } from "@okikio/opfs/archive/tar/stream";
import { openTar } from "@okikio/opfs/archive/tar";
import { createTarAdapter } from "@okikio/opfs/view/tar";
import { createByteSource } from "@okikio/opfs/source";

const tarView = createTarAdapter(await openTar(createByteSource(new Uint8Array())));
void tarView;
const tarEntry: TarWriteEntryType = { name: "typed", size: 0 };
await scanTar(createTarStream([tarEntry]), async (entry, body) => {
  const id: number = entry.id;
  for await (const bytes of body) {
    const size: number = bytes.byteLength;
    void size;
  }
  void id;
});
