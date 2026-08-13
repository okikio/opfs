import { openFileSystem, probeOpfs, type SyncFileType } from "../mod.ts";

const capabilities = await probeOpfs();
if (capabilities.rootAvailable && capabilities.syncAccessHandleExposed && capabilities.syncAccessHandleAllowedByContext) {
  const fileSystem = await openFileSystem();
  const file: SyncFileType = await fileSystem.openSyncFile("/cache/data.bin", {
    create: true,
    parents: true,
  });
  try {
    file.writeAll(new Uint8Array([1, 2, 3]));
    file.flush();
  } finally {
    file.close();
  }
}
