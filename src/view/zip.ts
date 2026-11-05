import type { AdapterType } from "../adapter/definition.ts";
import { defineReadAdapter } from "../adapter/read.ts";
import { defineDriver } from "../driver/definition.ts";
import { FileSystemError } from "../error.ts";
import type { PathType } from "../path.ts";
import type { FileDriverDirectoryEntryType, FileDriverReadOptionsType, FileDriverStatType } from "../driver/file.ts";
import type { ZipArchiveType, ZipEntryType, ZipReadOptionsType } from "../archive/zip.ts";
import { ArchiveError } from "../archive/zip.ts";

/** Each filesystem read has finite archive limits. No streaming claim is made for buffered results. */
export interface ZipViewOptionsType extends
  Pick<
    ZipReadOptionsType,
    "maxSourceBytes" | "maxRequests" | "maxDecodedBytes" | "maxOutputBytes" | "inflate" | "ledger"
  > {
  /** Full-member CRC checking is the default even for a selected range; disable explicitly for unchecked prefixes. */
  readonly verify?: boolean;
}

/** Projection keeps directory state separate from the archive's raw entry identity. */
interface NodeType {
  readonly kind: "file" | "directory";
  readonly entry?: ZipEntryType;
  readonly children: Map<string, string>;
}

/**
 * Projects a ZIP directory into an explicitly read-only filesystem adapter.
 *
 * Construction validates the entire namespace before any member read. Duplicate
 * names, dot components, absolute paths, links and path-kind collisions fail;
 * they are never normalized into overwrite. Implicit parents become synthetic
 * directories. The archive/source stay borrowed when the filesystem closes.
 */
export function createZipAdapter(archive: ZipArchiveType, options: ZipViewOptionsType = {}): AdapterType {
  const nodes = project(archive.entries);
  const find = (path: PathType): NodeType => {
    const node = nodes.get(path);
    if (!node) throw new FileSystemError("not-found", "read", path, "ZIP view entry does not exist.");
    return node;
  };
  const driver = {
    ...defineDriver({
      name: "zip",
      kind: "file",
      ownership: "borrowed",
      provides: ["stat", "read", "list"],
      limits: [{
        code: "preview-output-bytes",
        kind: "policy",
        source: "user",
        unit: "bytes",
        value: options.maxOutputBytes ?? 16 * 1024 * 1024,
      }],
      plan(input) {
        const supported = ["read", "stat", "list"].includes(input.operation);
        return {
          operation: input.operation,
          supported,
          support: supported ? "native" : "unsupported",
          problems: supported
            ? []
            : [{ code: "read-only", layer: "driver", severity: "error", message: "ZIP view is read-only." }],
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
    async readFile(path: PathType, readOptions: FileDriverReadOptionsType = {}): Promise<Uint8Array> {
      readOptions.signal?.throwIfAborted();
      const node = find(path);
      if (node.kind !== "file" || !node.entry) {
        throw new FileSystemError("type-mismatch", "read", path, "Cannot read a ZIP directory as a file.");
      }
      const at = readOptions.at ?? 0;
      const length = readOptions.length;
      if (
        !Number.isSafeInteger(at) || at < 0 || (length !== undefined && (!Number.isSafeInteger(length) || length < 0))
      ) throw new RangeError("ZIP view read offset and length must be nonnegative safe integers.");
      try {
        const result = await archive.read(node.entry.id, {
          ...options,
          offset: Math.min(at, node.entry.size),
          length: Math.min(length ?? node.entry.size, Math.max(0, node.entry.size - at)),
          verify: options.verify ?? true,
          ...(readOptions.signal === undefined ? {} : { signal: readOptions.signal }),
        });
        return result.bytes;
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
        throw new FileSystemError("type-mismatch", "list", path, "Cannot list a ZIP file.");
      }
      for (const [name, child] of node.children) yield { name, kind: nodes.get(child)!.kind };
    },
  };
  return defineReadAdapter({
    name: "zip",
    driver,
    capabilities: { streamRead: false, rangeRead: true },
    stat: driver.stat,
    readFile: driver.readFile,
    readDir: driver.readDir,
  });
}

/** Validate names before creating a tree so malformed input cannot acquire a useful partial projection. */
function project(entries: readonly ZipEntryType[]): Map<string, NodeType> {
  const nodes = new Map<string, NodeType>([["/", { kind: "directory", children: new Map() }]]);
  const explicit = new Set<string>();
  for (const entry of entries) {
    if (entry.kind === "symbolic-link" || entry.kind === "other") {
      throw new FileSystemError(
        "not-supported",
        "open",
        undefined,
        "ZIP filesystem views refuse links and special entries.",
      );
    }
    const name = entry.directory && entry.name.endsWith("/") ? entry.name.slice(0, -1) : entry.name;
    const parts = name.split("/");
    if (
      !name || name.startsWith("/") || /^[a-zA-Z]:/.test(name) || name.includes("\\") || name.includes("\0") ||
      parts.some((part) => !part || part === "." || part === "..")
    ) {
      throw new FileSystemError(
        "invalid-path",
        "open",
        entry.name,
        "ZIP view requires relative names without empty or dot components.",
      );
    }
    let parent = "/";
    for (let index = 0; index < parts.length; index++) {
      const part = parts[index]!;
      const path = parent === "/" ? `/${part}` : `${parent}/${part}`;
      const final = index === parts.length - 1;
      const kind = final && !entry.directory ? "file" : "directory";
      const previous = nodes.get(path);
      if ((previous && previous.kind !== kind) || (final && explicit.has(path))) {
        throw new FileSystemError(
          "invalid-path",
          "open",
          entry.name,
          "ZIP entries collide in the filesystem projection.",
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
