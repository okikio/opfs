/** Browser-target memory entry: optional protocols must not enter its bundle. */
import { createFileSystem } from "@okikio/opfs";
import { createMemoryAdapter } from "@okikio/opfs/adapter/memory";
import { normalizePath } from "@okikio/opfs/path";
export const smoke = () => [createFileSystem(createMemoryAdapter()), normalizePath("a/../b")];
