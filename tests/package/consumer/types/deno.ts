/** Compile-only native Deno leaf using its published FsFile declaration dependency. */
import { DenoRangeSource, DenoSyncFile, DenoWritableFile, writeStreamToFile } from "@okikio/opfs/driver/deno";
import { createDenoAdapter } from "@okikio/opfs/adapter/deno";
declare const file: Deno.FsFile;
const accepted: Parameters<typeof writeStreamToFile>[0] = file;
const range = new DenoRangeSource(accepted, 4);
const sync = new DenoSyncFile("/type-only", accepted);
const writable = new DenoWritableFile("/type-only", accepted);
const adapter = createDenoAdapter({ root: "/type-only" });
// @ts-expect-error The native leaf retains the real FsFile contract.
new DenoRangeSource({ read: async () => null }, 4);
// @ts-expect-error Synchronous resource construction also requires the complete native file.
new DenoSyncFile("/type-only", { readSync: () => null });
// @ts-expect-error Queued writable resource construction retains the native file contract.
new DenoWritableFile("/type-only", { write: async () => 0 });
void range;
void sync;
void writable;
void adapter;
