/**
 * Turn a list of archive entries into a read-only adapter.
 *
 * The TAR, ZIP and CPIO views use `createArchiveAdapter()`, so every archive view refuses the same unsafe names:
 * links, duplicates, `..` traversal and a file that is also a directory. A reader for another format can use it to
 * get the same checks. The format reader keeps ownership of verification and work budgets:
 *
 * ```ts
 * import { createArchiveAdapter } from "@okikio/opfs/view/_tree";
 * import { createFileSystem } from "@okikio/opfs";
 *
 * const entries = [{ id: 0, name: "notes/hello.txt", size: 5, kind: "file" }];
 * const adapter = createArchiveAdapter("example", entries, async (entry, { offset, length }) => {
 *   return new TextEncoder().encode("hello").slice(offset, offset + length);
 * });
 * const fs = createFileSystem(adapter);
 * console.log(await fs.readText("/notes/hello.txt")); // "hello"
 * ```
 *
 * @module
 */
import type { AdapterType } from "../adapter/definition.ts";
import { defineReadAdapter } from "../adapter/read.ts";
import { defineDriver } from "../driver/definition.ts";
import { FileSystemError } from "../error.ts";
import type { PathType } from "../path.ts";
import type { FileDriverDirectoryEntryType, FileDriverReadOptionsType, FileDriverStatType } from "../driver/file.ts";
import { ArchiveError } from "../archive/error.ts";

/** Literal identity and regular-file size; links stay visible to admission and are refused. */
export interface EntryType {
  /** Format-owned identity passed back to `read`. */
  readonly id: number;
  /** Archive member name. A directory name can end in `/`. */
  readonly name: string;
  /** Regular-file size in bytes. */
  readonly size: number;
  /** `"file"` or `"directory"`. Any other kind, such as a link, makes the whole view fail. */
  readonly kind: string;
}
interface NodeType<T> {
  readonly kind: "file" | "directory";
  readonly entry?: T;
  readonly children: Map<string, string>;
}
/** Normalized member range. The format reader still owns verification and work budgets. */
export interface ReadType {
  /** First byte of the member to return. */
  readonly offset: number;
  /** Bytes to return. */
  readonly length: number;
  /** Cancels this read. */
  readonly signal?: AbortSignal;
}

/**
 * Validates every entry name, then returns a read-only adapter whose reads call `read(entry, range)`.
 *
 * Validation happens before the adapter exists, so an unsafe archive never becomes a filesystem. `name` is the
 * adapter's diagnostic name. `maxOutputBytes` caps one read's returned bytes; the default is 16 MiB. The generic
 * entry type lets each format keep its own entry identity and fields.
 */
export function createArchiveAdapter<T extends EntryType>(
  name: string,
  entries: readonly T[],
  read: (entry: T, options: ReadType) => Promise<Uint8Array>,
  maxOutputBytes = 16 * 1024 * 1024,
): AdapterType {
  if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 0) {
    throw new RangeError("Invalid preview output limit.");
  }
  const nodes = project(entries);
  const find = (path: PathType): NodeType<T> => {
    const node = nodes.get(path);
    if (!node) throw new FileSystemError("not-found", "read", path, "Archive view entry does not exist.");
    return node;
  };
  const driver = {
    ...defineDriver({
      name,
      kind: "file",
      ownership: "borrowed",
      provides: ["stat", "read", "list"],
      limits: [{ code: "preview-output-bytes", kind: "policy", source: "user", unit: "bytes", value: maxOutputBytes }],
      plan(input) {
        const supported = ["read", "stat", "list"].includes(input.operation);
        return {
          operation: input.operation,
          supported,
          support: supported ? "native" : "unsupported",
          problems: supported
            ? []
            : [{ code: "read-only", layer: "driver", severity: "error", message: "Archive view is read-only." }],
          actions: [],
        };
      },
    }),
    async stat(path: PathType): Promise<FileDriverStatType | null> {
      const node = nodes.get(path);
      if (!node) return null;
      return node.kind === "directory"
        ? { kind: "directory" }
        : { kind: "file", size: node.entry!.size, lastModified: 0, mediaType: "" };
    },
    async readFile(path: PathType, options: FileDriverReadOptionsType = {}): Promise<Uint8Array> {
      options.signal?.throwIfAborted();
      const node = find(path);
      if (node.kind !== "file" || !node.entry) {
        throw new FileSystemError("type-mismatch", "read", path, "Cannot read an archive directory as a file.");
      }
      const at = options.at ?? 0;
      const length = options.length;
      if (
        !Number.isSafeInteger(at) || at < 0 || (length !== undefined && (!Number.isSafeInteger(length) || length < 0))
      ) {
        throw new RangeError("Archive view range must use nonnegative safe integers.");
      }
      try {
        return await read(node.entry, {
          offset: Math.min(at, node.entry.size),
          length: Math.min(length ?? node.entry.size, Math.max(0, node.entry.size - at)),
          ...(options.signal === undefined ? {} : { signal: options.signal }),
        });
      } catch (cause) {
        if (cause instanceof ArchiveError) {
          throw new FileSystemError(
            cause.code === "unsupported-profile"
              ? "not-supported"
              : cause.code === "budget-exceeded"
              ? "too-large"
              : "unknown",
            "read",
            path,
            cause.message,
            cause,
          );
        }
        throw cause;
      }
    },
    async *readDir(path: PathType): AsyncIterableIterator<FileDriverDirectoryEntryType> {
      const node = find(path);
      if (node.kind !== "directory") {
        throw new FileSystemError("type-mismatch", "list", path, "Cannot list an archive file.");
      }
      for (const [name, child] of node.children) yield { name, kind: nodes.get(child)!.kind };
    },
  };
  return defineReadAdapter({
    name,
    driver,
    capabilities: { streamRead: false, rangeRead: true },
    stat: driver.stat,
    readFile: driver.readFile,
    readDir: driver.readDir,
  });
}

/** Never normalize raw names into collisions or allow links to become host paths. */
function project<T extends EntryType>(entries: readonly T[]): Map<string, NodeType<T>> {
  const nodes = new Map<string, NodeType<T>>([["/", { kind: "directory", children: new Map() }]]);
  const explicit = new Set<string>();
  const ids = new Set<number>();
  for (const input of entries) {
    // Capture public descriptor values once; callers may retain a mutable backing object.
    const entry = Object.freeze({ ...input });
    if (entry.kind !== "file" && entry.kind !== "directory") {
      throw new FileSystemError("not-supported", "open", entry.name, "Archive views refuse links and special entries.");
    }
    if (
      !Number.isSafeInteger(entry.id) || entry.id < 0 || ids.has(entry.id) || !Number.isSafeInteger(entry.size) ||
      entry.size < 0
    ) {
      throw new TypeError("Archive view requires unique nonnegative entry IDs and safe sizes.");
    }
    ids.add(entry.id);
    const name = entry.kind === "directory" && entry.name.endsWith("/") ? entry.name.slice(0, -1) : entry.name;
    const parts = name.split("/");
    if (
      !name || name.startsWith("/") || /^[a-zA-Z]:/.test(name) || name.includes("\\") || name.includes("\0") ||
      parts.some((part) => !part || part === "." || part === "..")
    ) {
      throw new FileSystemError(
        "invalid-path",
        "open",
        entry.name,
        "Archive views require relative names without empty or dot components.",
      );
    }
    let parent = "/";
    for (let index = 0; index < parts.length; index++) {
      const part = parts[index]!;
      const path = parent === "/" ? `/${part}` : `${parent}/${part}`;
      const final = index === parts.length - 1;
      const kind = final && entry.kind === "file" ? "file" : "directory";
      const previous = nodes.get(path);
      if ((previous && previous.kind !== kind) || (final && explicit.has(path))) {
        throw new FileSystemError(
          "invalid-path",
          "open",
          entry.name,
          "Archive entries collide in the filesystem projection.",
        );
      }
      if (!previous) nodes.set(path, { kind, ...(final ? { entry } : {}), children: new Map() });
      nodes.get(parent)!.children.set(part, path);
      if (final) explicit.add(path);
      parent = path;
    }
  }
  return nodes;
}
