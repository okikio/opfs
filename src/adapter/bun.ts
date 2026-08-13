import type { AdapterType } from "./definition.ts";
import { defineAdapter } from "./definition.ts";
import { createLocalPath } from "./local.ts";
import { createNodeAdapter, type NodeAdapterOptionsType } from "./node.ts";
import { throwIfAborted } from "../error.ts";
import { withAbortSignal } from "../stream.ts";

/** Minimal Bun file object used without requiring global Bun types in core declarations. */
interface BunFileType extends Blob {}

/** Bun runtime methods used by this adapter. */
interface BunRuntimeType {
  /** Opens a lazy BunFile for a host path. */
  file(path: string): BunFileType;
  /** Writes a Blob, Response, stream-compatible body, or bytes to a host path. */
  write(path: string, data: Blob | Response | ArrayBufferView | ArrayBuffer | string): Promise<number>;
}

/** Options for the Bun filesystem adapter. */
export type BunAdapterOptionsType = NodeAdapterOptionsType;

/**
 * Resolves Bun lazily so importing the adapter remains safe in Node and Deno.
 *
 * The explicit subpath can therefore be type-checked or inspected outside Bun;
 * only adapter creation requires the runtime global.
 */
function getBun(): BunRuntimeType {
  const runtime = Reflect.get(globalThis, "Bun") as BunRuntimeType | undefined;
  if (runtime === undefined || typeof runtime.file !== "function" || typeof runtime.write !== "function") {
    throw new TypeError("Bun adapter requires the Bun runtime.");
  }
  return runtime;
}

/**
 * Creates an adapter optimized for Bun.
 *
 * BunFile supplies lazy reads and streaming reads. `Bun.write()` supplies the
 * fast replace path. Directory traversal, positional writes, rename, and sync
 * descriptor operations reuse Bun's Node-compatible filesystem implementation.
 * `Bun` is resolved lazily during adapter creation, not at module evaluation.
 *
 * @example
 * ```ts
 * import { createFileSystem } from "@okikio/opfs";
 * import { createBunAdapter } from "@okikio/opfs/adapter/bun";
 *
 * const fs = createFileSystem(createBunAdapter({ root: "./data" }));
 * await fs.writeFile("/result.bin", new Uint8Array([1, 2, 3]));
 * ```
 */
export function createBunAdapter(options: BunAdapterOptionsType): AdapterType {
  const bun = getBun();
  const hostPath = createLocalPath(options.root);
  const node = createNodeAdapter(options);

  return defineAdapter({
    ...node,
    name: "bun",
    async readFile(path, readOptions = {}) {
      throwIfAborted(readOptions.signal, "read", path);
      const file = bun.file(hostPath(path));
      const start = readOptions.at ?? 0;
      const end = readOptions.length === undefined ? file.size : Math.min(file.size, start + readOptions.length);
      return new Uint8Array(await file.slice(start, end).arrayBuffer());
    },
    async openReadStream(path, readOptions = {}) {
      throwIfAborted(readOptions.signal, "read", path);
      const file = bun.file(hostPath(path));
      const start = readOptions.at ?? 0;
      const end = readOptions.length === undefined ? file.size : Math.min(file.size, start + readOptions.length);
      return file.slice(start, end).stream() as ReadableStream<Uint8Array>;
    },
    async writeFile(path, data, writeOptions) {
      if (writeOptions.mode === "replace") {
        throwIfAborted(writeOptions.signal, "write", path);
        await bun.write(hostPath(path), data);
        return;
      }
      await node.writeFile(path, data, writeOptions);
    },
    async writeStream(path, source, writeOptions) {
      if (writeOptions.mode === "replace") {
        throwIfAborted(writeOptions.signal, "write", path);
        await bun.write(hostPath(path), new Response(withAbortSignal(source, writeOptions.signal, path, "write")));
        return;
      }
      if (node.writeStream === undefined) {
        throw new TypeError("Bun Node compatibility layer does not expose streaming writes.");
      }
      await node.writeStream(path, source, writeOptions);
    },
  });
}
