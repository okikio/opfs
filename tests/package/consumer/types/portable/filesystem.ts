/** Compile-only installed filesystem contracts; never execute these expressions. */
import { createFileSystem, type FileSystemType } from "@okikio/opfs";
import { createMemoryAdapter } from "@okikio/opfs/adapter/memory";
import { createD1Adapter } from "@okikio/opfs/adapter/d1";
import type { D1BindingType } from "@okikio/opfs/driver/d1";

declare const binding: D1BindingType;
const d1: FileSystemType = createFileSystem(await createD1Adapter(binding));
void d1;
const fileSystem: FileSystemType = createFileSystem(createMemoryAdapter());
await fileSystem.writeFile("/types.txt", "ok", { parents: true });
