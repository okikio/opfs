/** Compile the installed portable root with actual Deno, independently of repository aliases. */
import { createFileSystem, type FileSystemType } from "@okikio/opfs";
import { createMemoryAdapter } from "@okikio/opfs/adapter/memory";
const fileSystem: FileSystemType = createFileSystem(createMemoryAdapter());
await fileSystem.writeFile("/types.txt", "ok", { parents: true });
