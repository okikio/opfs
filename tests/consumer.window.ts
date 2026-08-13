import { openFileSystem, probeOpfs, type WalkEntryType } from "../mod.ts";
import { joinPath } from "../src/path.ts";

const capabilities = await probeOpfs();
if (capabilities.rootAvailable) {
  const fileSystem = await openFileSystem();
  await fileSystem.writeFile(
    joinPath("cache", "record.json"),
    JSON.stringify({ ok: true }),
    { parents: true },
  );
  for await (const entry of fileSystem.walk("/cache")) {
    const typed: WalkEntryType = entry;
    void typed.path;
  }
}
