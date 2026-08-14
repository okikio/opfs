/// <reference types="deno" />
import { defineAdapter, type AdapterType } from "./definition.ts";
import { createLocalPath } from "./local.ts";
import { throwIfAborted, toFileSystemError } from "../error.ts";

/** Options for the Deno-native filesystem adapter. */
export interface DenoAdapterOptionsType {
  /** Host directory exposed as virtual `/`. */
  readonly root: string;
  /** Creates the host root during adapter creation. Defaults to true. */
  readonly createRoot?: boolean;
}

/**
 * Creates an adapter backed by Deno file APIs.
 *
 * Production remains Deno-native: reads, writes, directory enumeration, rename,
 * synchronous access, and flush all use `Deno.*`. `node:path` is used only for
 * host-path normalization because Deno provides that compatibility module.
 *
 * @example Persist below one Deno host directory.
 * ```ts
 * import { createFileSystem } from "@okikio/opfs";
 * import { createDenoAdapter } from "@okikio/opfs/adapter/deno";
 *
 * const fs = createFileSystem(createDenoAdapter({ root: "./data" }), {
 *   coordination: "local",
 * });
 * await fs.writeFile("/cache/result.json", "{}", { parents: true });
 * ```
 */
export function createDenoAdapter(options: DenoAdapterOptionsType): AdapterType {
  const hostPath = createLocalPath(options.root);
  if (options.createRoot ?? true) Deno.mkdirSync(hostPath("/"), { recursive: true });

  return defineAdapter({
    name: "deno",
    capabilities: {
      read: true,
      write: true,
      streamRead: true,
      streamWrite: true,
      rangeRead: true,
      nativeMove: true,
      positionalWrite: true,
      syncAccess: true,
    },
    async stat(path, operationOptions) {
      throwIfAborted(operationOptions?.signal, "stat", path);
      try {
        const info = await Deno.stat(hostPath(path));
        return info.isDirectory
          ? { kind: "directory", ...(info.mtime === null ? {} : { lastModified: info.mtime.getTime() }) }
          : { kind: "file", size: info.size, lastModified: info.mtime?.getTime() ?? 0, mediaType: "" };
      } catch (error) {
        const mapped = toFileSystemError(error, "stat", path);
        if (mapped.code === "not-found") return null;
        throw mapped;
      }
    },
    async readFile(path, readOptions = {}) {
      throwIfAborted(readOptions.signal, "read", path);
      if (readOptions.at === undefined && readOptions.length === undefined) return await Deno.readFile(hostPath(path));
      const file = await Deno.open(hostPath(path), { read: true });
      try {
        const info = await file.stat();
        const start = readOptions.at ?? 0;
        const length = Math.max(0, Math.min(readOptions.length ?? info.size - start, info.size - start));
        await file.seek(start, Deno.SeekMode.Start);
        const output = new Uint8Array(length);
        let offset = 0;
        while (offset < length) {
          const count = await file.read(output.subarray(offset));
          if (count === null) break;
          offset += count;
        }
        return offset === output.byteLength ? output : output.slice(0, offset);
      } finally {
        file.close();
      }
    },
    async openReadStream(path, readOptions = {}) {
      throwIfAborted(readOptions.signal, "read", path);
      if (readOptions.at === undefined && readOptions.length === undefined) {
        return (await Deno.open(hostPath(path), { read: true })).readable;
      }
      const bytes = await this.readFile(path, readOptions);
      return new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(bytes);
          controller.close();
        },
      });
    },
    async writeFile(path, data, writeOptions) {
      throwIfAborted(writeOptions.signal, "write", path);
      if (writeOptions.mode === "replace") {
        await Deno.writeFile(hostPath(path), data, { create: true });
        return;
      }
      const file = await Deno.open(hostPath(path), { read: true, write: true, create: true });
      try {
        const position = writeOptions.mode === "append" ? (await file.stat()).size : writeOptions.at ?? 0;
        await file.seek(position, Deno.SeekMode.Start);
        let offset = 0;
        while (offset < data.byteLength) offset += await file.write(data.subarray(offset));
        if (writeOptions.truncate) await file.truncate(position + data.byteLength);
      } finally {
        file.close();
      }
    },
    async writeStream(path, source, writeOptions) {
      const file = await Deno.open(hostPath(path), {
        read: true,
        write: true,
        create: true,
        truncate: writeOptions.mode === "replace",
      });
      try {
        let position = writeOptions.mode === "append"
          ? (await file.stat()).size
          : writeOptions.mode === "update"
          ? writeOptions.at ?? 0
          : 0;
        await file.seek(position, Deno.SeekMode.Start);
        const reader = source.getReader();
        try {
          while (true) {
            throwIfAborted(writeOptions.signal, "write", path);
            const next = await reader.read();
            if (next.done) break;
            let offset = 0;
            while (offset < next.value.byteLength) {
              offset += await file.write(next.value.subarray(offset));
            }
            position += next.value.byteLength;
          }
        } catch (error) {
          try {
            await reader.cancel(error);
          } catch {
            // Preserve the first write or cancellation failure.
          }
          throw error;
        } finally {
          reader.releaseLock();
        }
        if (writeOptions.truncate) await file.truncate(position);
      } finally {
        file.close();
      }
    },
    async *readDir(path, operationOptions) {
      throwIfAborted(operationOptions?.signal, "read-dir", path);
      for await (const entry of Deno.readDir(hostPath(path))) {
        throwIfAborted(operationOptions?.signal, "read-dir", path);
        if (entry.isDirectory) yield { name: entry.name, kind: "directory" };
        else if (entry.isFile) yield { name: entry.name, kind: "file" };
      }
    },
    async createDir(path, operationOptions) {
      throwIfAborted(operationOptions?.signal, "mkdir", path);
      await Deno.mkdir(hostPath(path));
    },
    async remove(path, operationOptions) {
      throwIfAborted(operationOptions?.signal, "remove", path);
      await Deno.remove(hostPath(path));
    },
    async move(source, destination, operationOptions) {
      throwIfAborted(operationOptions.signal, "move", source);
      await Deno.rename(hostPath(source), hostPath(destination));
    },
    async openWritableFile(path) {
      const file = await Deno.open(hostPath(path), { read: true, write: true });
      let closed = false;
      const getFile = () => {
        if (closed) throw new Error(`Writable file '${path}' is closed.`);
        return file;
      };
      return {
        async write(buffer, writeOptions) {
          const source = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
          const target = getFile();
          await target.seek(writeOptions.at, Deno.SeekMode.Start);
          let offset = 0;
          while (offset < source.byteLength) {
            const count = await target.write(source.subarray(offset));
            if (count <= 0) throw new Error(`Deno positional write made no progress for '${path}'.`);
            offset += count;
          }
        },
        async truncate(size) {
          await getFile().truncate(size);
        },
        async flush() {
          await getFile().sync();
        },
        async close() {
          if (closed) return;
          closed = true;
          file.close();
        },
        async abort() {
          if (closed) return;
          closed = true;
          file.close();
        },
      };
    },
    async openSyncFile(path) {
      const file = Deno.openSync(hostPath(path), { read: true, write: true });
      let cursor = 0;
      return {
        read(buffer, readOptions = {}) {
          const target = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
          const at = readOptions.at ?? cursor;
          file.seekSync(at, Deno.SeekMode.Start);
          const count = file.readSync(target) ?? 0;
          cursor = at + count;
          return count;
        },
        write(buffer, writeOptions = {}) {
          const source = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
          const at = writeOptions.at ?? cursor;
          file.seekSync(at, Deno.SeekMode.Start);
          const count = file.writeSync(source);
          cursor = at + count;
          return count;
        },
        getSize() {
          return file.statSync().size;
        },
        truncate(size) {
          file.truncateSync(size);
          if (cursor > size) cursor = size;
        },
        flush() {
          file.syncSync();
        },
        close() {
          file.close();
        },
      };
    },
  });
}
