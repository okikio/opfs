/** Compile-only native Deno leaf using its published FsFile declaration dependency. */
import { DenoRangeSource, writeStreamToFile } from "@okikio/opfs/driver/deno";
import { createDenoAdapter } from "@okikio/opfs/adapter/deno";
declare const file: Deno.FsFile;
const accepted: Parameters<typeof writeStreamToFile>[0] = file;
const range = new DenoRangeSource(accepted, 4);
const adapter = createDenoAdapter({ root: "/type-only" });
// @ts-expect-error The native leaf retains the real FsFile contract.
new DenoRangeSource({ read: async () => null }, 4);
void range;
void adapter;
