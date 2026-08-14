import type { FileHandle as NodeFileHandle } from "node:fs/promises";
import { defineAdapter, type AdapterType, type AdapterWriteOptionsType } from "./definition.ts";
import { createLocalPath } from "./local.ts";
import { throwIfAborted, toFileSystemError } from "../error.ts";

/** Options for a Node filesystem adapter. */
export interface NodeAdapterOptionsType {
  /** Host directory exposed as virtual `/`. */
  readonly root: string;
  /** Creates the host root during adapter creation. Defaults to true. */
  readonly createRoot?: boolean;
}

/**
 * Drains a Web byte stream into one Node file descriptor.
 *
 * The descriptor stays open for the full stream so sequential chunks do not
 * repeatedly open the file. Partial writes advance `position` until each chunk
 * is fully committed. On failure the producer is cancelled before the file is
 * closed, which prevents an upstream stream from continuing useless work.
 */
async function writeStreamToFile(
  path: string,
  source: ReadableStream<Uint8Array>,
  options: AdapterWriteOptionsType,
): Promise<void> {
  const { open } = globalThis?.process?.getBuiltinModule?.("node:fs/promises");
  let file: NodeFileHandle | undefined;
  try {
    file = await open(path, options.mode === "replace" ? "w+" : "a+");
    let position = options.mode === "replace"
      ? 0
      : options.mode === "append"
      ? (await file.stat()).size
      : options.at ?? 0;
    if (options.mode === "update") {
      await file.close();
      file = await open(path, "r+").catch(async (error) => {
        if (toFileSystemError(error, "write", path).code !== "not-found") throw error;
        return await open(path, "w+");
      });
    }
    const reader = source.getReader();
    try {
      while (true) {
        throwIfAborted(options.signal, "write", path);
        const next = await reader.read();
        if (next.done) break;
        let offset = 0;
        while (offset < next.value.byteLength) {
          const result = await file.write(next.value, offset, next.value.byteLength - offset, position);
          if (result.bytesWritten <= 0) {
            throw new Error(`Node write made no progress for '${path}'.`);
          }
          offset += result.bytesWritten;
          position += result.bytesWritten;
        }
      }
    } catch (error) {
      try {
        await reader.cancel(error);
      } catch {
        // Preserve the first failure.
      }
      throw error;
    } finally {
      reader.releaseLock();
    }
    if (options.truncate) await file.truncate(position);
  } finally {
    await file?.close();
  }
}

/**
 * Creates an adapter over Node's `node:fs` APIs.
 *
 * The adapter maps virtual `/` to `root`. It never exposes host paths through
 * the facade. Synchronous access uses Node file descriptors and therefore works
 * in the main thread as well as worker threads. The caller owns the adapter
 * unless `createFileSystem(..., { disposeAdapter: true })` transfers disposal.
 *
 * @example Use OPFS-shaped handles over a host directory.
 * ```ts
 * import { createFileSystem } from "@okikio/opfs";
 * import { createNodeAdapter } from "@okikio/opfs/adapter/node";
 *
 * const fs = createFileSystem(createNodeAdapter({ root: "./data" }));
 * const file = await fs.root.getFileHandle("state.json", { create: true });
 * const writable = await file.createWritable();
 * await writable.write("{}");
 * await writable.close();
 * ```
 */
export function createNodeAdapter(options: NodeAdapterOptionsType): AdapterType {
  const { 
    closeSync,
    createReadStream,
    fstatSync,
    fsyncSync,
    ftruncateSync,
    mkdirSync,
    openSync,
    readSync,
    writeSync,
  } = globalThis?.process?.getBuiltinModule?.("node:fs");

  const { 
    appendFile,
    mkdir,
    open,
    readFile,
    readdir,
    rename,
    rm,
    stat,
    writeFile,
  } = globalThis?.process?.getBuiltinModule?.("node:fs/promises");

  const hostPath = createLocalPath(options.root);
  if (options.createRoot ?? true) mkdirSync(hostPath("/"), { recursive: true });

  return defineAdapter({
    name: "node",
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
        const info = await stat(hostPath(path));
        return info.isDirectory()
          ? { kind: "directory", lastModified: info.mtimeMs }
          : { kind: "file", size: info.size, lastModified: info.mtimeMs, mediaType: "" };
      } catch (error) {
        const mapped = toFileSystemError(error, "stat", path);
        if (mapped.code === "not-found") return null;
        throw mapped;
      }
    },
    async readFile(path, readOptions = {}) {
      throwIfAborted(readOptions.signal, "read", path);
      if (readOptions.at === undefined && readOptions.length === undefined) {
        return new Uint8Array(await readFile(hostPath(path)));
      }
      const file = await open(hostPath(path), "r");
      try {
        const info = await file.stat();
        const start = readOptions.at ?? 0;
        const length = Math.max(0, Math.min(readOptions.length ?? info.size - start, info.size - start));
        const output = new Uint8Array(length);
        let offset = 0;
        while (offset < length) {
          const result = await file.read(output, offset, length - offset, start + offset);
          if (result.bytesRead === 0) break;
          offset += result.bytesRead;
        }
        return offset === output.byteLength ? output : output.slice(0, offset);
      } finally {
        await file.close();
      }
    },
    async openReadStream(path, readOptions = {}) {
      const { Readable } = globalThis?.process?.getBuiltinModule?.("node:stream");

      throwIfAborted(readOptions.signal, "read", path);
      const start = readOptions.at ?? 0;
      const end = readOptions.length === undefined ? undefined : Math.max(start, start + readOptions.length - 1);
      const stream = createReadStream(hostPath(path), { start, ...(end === undefined ? {} : { end }) });
      return Readable.toWeb(stream) as unknown as ReadableStream<Uint8Array>;
    },
    async writeFile(path, data, writeOptions) {
      throwIfAborted(writeOptions.signal, "write", path);
      const target = hostPath(path);
      if (writeOptions.mode === "replace") {
        await writeFile(target, data);
        return;
      }
      if (writeOptions.mode === "append") {
        await appendFile(target, data);
        return;
      }
      const file = await open(target, "r+").catch(async (error) => {
        if (toFileSystemError(error, "write", path).code !== "not-found") throw error;
        return await open(target, "w+");
      });
      try {
        const position = writeOptions.at ?? 0;
        let offset = 0;
        while (offset < data.byteLength) {
          const result = await file.write(data, offset, data.byteLength - offset, position + offset);
          if (result.bytesWritten <= 0) {
            throw new Error(`Node write made no progress for '${path}'.`);
          }
          offset += result.bytesWritten;
        }
        if (writeOptions.truncate) await file.truncate(position + data.byteLength);
      } finally {
        await file.close();
      }
    },
    async writeStream(path, source, writeOptions) {
      await writeStreamToFile(hostPath(path), source, writeOptions);
    },
    async *readDir(path, operationOptions) {
      throwIfAborted(operationOptions?.signal, "read-dir", path);
      for (const entry of await readdir(hostPath(path), { withFileTypes: true })) {
        throwIfAborted(operationOptions?.signal, "read-dir", path);
        if (entry.isDirectory()) yield { name: entry.name, kind: "directory" };
        else if (entry.isFile()) yield { name: entry.name, kind: "file" };
      }
    },
    async createDir(path, operationOptions) {
      throwIfAborted(operationOptions?.signal, "mkdir", path);
      await mkdir(hostPath(path));
    },
    async remove(path, operationOptions) {
      throwIfAborted(operationOptions?.signal, "remove", path);
      await rm(hostPath(path));
    },
    async move(source, destination, operationOptions) {
      throwIfAborted(operationOptions.signal, "move", source);
      await rename(hostPath(source), hostPath(destination));
    },
    async openWritableFile(path) {
      const file = await open(hostPath(path), "r+");
      let closed = false;
      const getFile = () => {
        if (closed) throw new Error(`Writable file '${path}' is closed.`);
        return file;
      };
      return {
        async write(buffer, writeOptions) {
          const source = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
          let offset = 0;
          while (offset < source.byteLength) {
            const result = await getFile().write(
              source,
              offset,
              source.byteLength - offset,
              writeOptions.at + offset,
            );
            if (result.bytesWritten <= 0) {
              throw new Error(`Node positional write made no progress for '${path}'.`);
            }
            offset += result.bytesWritten;
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
          await file.close();
        },
        async abort() {
          if (closed) return;
          closed = true;
          await file.close();
        },
      };
    },
    async openSyncFile(path) {
      const descriptor = openSync(hostPath(path), "r+");
      let cursor = 0;
      let closed = false;
      const getDescriptor = () => {
        if (closed) throw new Error(`Sync file '${path}' is closed.`);
        return descriptor;
      };
      return {
        read(buffer, readOptions = {}) {
          const target = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
          const position = readOptions.at ?? cursor;
          const count = readSync(getDescriptor(), target, 0, target.byteLength, position);
          cursor = position + count;
          return count;
        },
        write(buffer, writeOptions = {}) {
          const source = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
          const position = writeOptions.at ?? cursor;
          const count = writeSync(getDescriptor(), source, 0, source.byteLength, position);
          cursor = position + count;
          return count;
        },
        getSize() {
          return fstatSync(getDescriptor()).size;
        },
        truncate(size) {
          ftruncateSync(getDescriptor(), size);
          if (cursor > size) cursor = size;
        },
        flush() {
          fsyncSync(getDescriptor());
        },
        close() {
          if (closed) return;
          closed = true;
          closeSync(descriptor);
        },
      };
    },
  });
}
