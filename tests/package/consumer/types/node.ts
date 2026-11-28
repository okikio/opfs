/** Compile-only Node host contract; native Deno declarations must remain absent. */
import { createFileSystem } from "@okikio/opfs";
import { createNodeAdapter } from "@okikio/opfs/adapter/node";
import type { NodeFsPromisesType } from "@okikio/opfs/driver/node";
import type { FileHandle } from "node:fs/promises";
const fileSystem = createFileSystem(createNodeAdapter({ root: "/type-only" }));
declare const host: NodeFsPromisesType;
const file: FileHandle = await host.open("/type-only/input", "r");
// @ts-expect-error Node declarations must not load the native Deno namespace.
void Deno;
void fileSystem;
void file;
