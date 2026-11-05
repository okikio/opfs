/** Conservative file projection of native WebHDFS; mkdir and rename retain client-only semantics. @module */
import { createWebhdfsClient, WebhdfsError, WebhdfsRejectionError } from "../webhdfs.ts";
import type { WebhdfsClientOptionsType, WebhdfsClientType } from "../webhdfs.ts";
import { defineFileDriver } from "./file.ts";
import type { FileBackendType, FileDriverType } from "./file.ts";
import type { DriverPlanInputType, DriverPlanType } from "./definition.ts";
import { range } from "../range.ts";
import { collectBytes } from "../stream.ts";
import { FileSystemError } from "../error.ts";
import { getPrimary } from "../close.ts";
import type { PathType } from "../path.ts";

/** Materialized file reads have a separate allocation bound from native OPEN streams. */
export interface WebhdfsProjectionOptionsType {
  readonly maxBufferedReadBytes?: number;
}
/** Creates a native client and file projection without probing or discovering credentials. */
export interface WebhdfsDriverOptionsType extends WebhdfsClientOptionsType, WebhdfsProjectionOptionsType {}

/** Status mapping preserves native/cleanup causes; unknown publication remains distinguishable. */
async function translated<Value>(operation: string, path: PathType, action: () => Promise<Value>): Promise<Value> {
  try {
    return await action();
  } catch (reason) {
    const primary = getPrimary(reason)?.reason ?? reason;
    if (primary instanceof WebhdfsRejectionError) {
      throw new FileSystemError(
        "invalid-operation",
        operation,
        path,
        "WebHDFS returned boolean false without a specific rejection reason.",
        reason,
      );
    }
    if (!(primary instanceof WebhdfsError)) throw reason;
    const status = primary.status;
    const code = status === 404
      ? "not-found"
      : status === 401 || status === 403
      ? "permission-denied"
      : status === 409
      ? "locked"
      : status === 429 || status === 507
      ? "quota-exceeded"
      : status === 405 || status === 501
      ? "not-supported"
      : status >= 500
      ? "unavailable"
      : "unknown";
    throw new FileSystemError(code, operation, path, `WebHDFS ${operation} failed with HTTP ${status}.`, reason);
  }
}

/** No generic write-without-mode admission: that route creates directories/reservations, which MKDIRS cannot safely implement. */
function admission(input: DriverPlanInputType): DriverPlanType {
  const refused = input.operation === "copy" || input.operation === "move" || input.intent === "copy" ||
    input.intent === "move" ||
    (input.operation === "write" &&
      (input.mode === undefined || input.mode === "update" || input.source === "stream" || input.exclusive === true));
  return {
    operation: input.operation,
    supported: !refused,
    support: refused ? "unsupported" : "native",
    problems: refused
      ? [{
        code: "webhdfs-primitives",
        layer: "driver",
        severity: "error",
        message:
          "WebHDFS admits materialized replace/append; canonical mkdir, update, stream writes, copy/move and exclusive publication are unsupported.",
      }]
      : [],
    actions: refused ? [{ kind: "select-driver" }] : [],
  };
}

/** Borrows a configured client. Closing the filesystem does not close its credentials or transport. */
export function createWebhdfsDriverFromClient(
  client: WebhdfsClientType,
  options: WebhdfsProjectionOptionsType = {},
): FileDriverType {
  const maximum = options.maxBufferedReadBytes ?? 8 * 1024 * 1024;
  if (!Number.isSafeInteger(maximum) || maximum < 0) {
    throw new RangeError("maxBufferedReadBytes must be a nonnegative safe integer.");
  }
  const backend: FileBackendType = {
    name: client.name,
    capabilities: {
      read: true,
      write: true,
      streamRead: true,
      streamWriteModes: [],
      rangeRead: true,
      copy: false,
      move: false,
      positionalWrite: false,
      syncAccess: false,
    },
    publication: { copy: "unsupported", move: "unsupported", noReplace: "unsupported", durability: "acknowledged" },
    admit: admission,
    stat: (path, request) =>
      translated("stat", path, async () => {
        const found = await client.stat(path, request);
        if (found === null) return null;
        if (found.kind === "link") {
          throw new FileSystemError(
            "not-supported",
            "stat",
            path,
            "WebHDFS symbolic links cannot be projected as regular entries.",
          );
        }
        return found.kind === "directory"
          ? { kind: "directory", lastModified: found.lastModified }
          : { kind: "file", size: found.size, lastModified: found.lastModified, mediaType: "" };
      }),
    readFile: (path, request = {}) =>
      translated("read", path, async () => {
        const selected = range(request);
        if (selected.empty) return new Uint8Array();
        const requested = selected.end === undefined ? undefined : selected.end - selected.start + 1;
        if (requested !== undefined && requested > maximum) {
          throw new RangeError("WebHDFS readFile exceeds maxBufferedReadBytes.");
        }
        const stream = await client.get(path, {
          at: selected.start,
          ...(requested === undefined ? {} : { length: requested }),
          ...(selected.signal === undefined ? {} : { signal: selected.signal }),
        });
        return await collectBytes(stream, maximum, selected.signal, "read", path);
      }),
    writeFile: (path, bytes, request) =>
      translated("write", path, async () => {
        if (request.mode === "replace") {
          await client.put(path, bytes, {
            overwrite: true,
            ...(request.signal === undefined ? {} : { signal: request.signal }),
          });
        } else if (request.mode === "append") {
          const options = request.signal === undefined ? {} : { signal: request.signal };
          try {
            await client.append(path, bytes, options);
          } catch (reason) {
            // A known missing-file rejection has appended no bytes. Exclusive
            // create preserves a concurrent creator; ambiguous acknowledgements never enter this fallback.
            if (!(reason instanceof WebhdfsError) || reason.status !== 404) throw reason;
            await client.put(path, bytes, { ...options, overwrite: false });
          }
        } else throw new FileSystemError("not-supported", "write", path, "WebHDFS positional update is unsupported.");
      }),
    async *readDir(path, request) {
      const entries = await translated("list", path, () => client.list(path, request));
      // Validate the complete materialized page set before yielding any partial namespace.
      if (entries.some((entry) => entry.kind === "link")) {
        throw new FileSystemError("not-supported", "list", path, "WebHDFS listing contains a symbolic link.");
      }
      for (const entry of entries) yield { name: entry.name, kind: entry.kind as "file" | "directory" };
    },
    createDir: (path) => {
      throw new FileSystemError(
        "not-supported",
        "mkdir",
        path,
        "Native WebHDFS MKDIRS recursively creates parents and cannot implement a one-entry primitive.",
      );
    },
    remove: (path, request) =>
      translated(
        "remove",
        path,
        () =>
          client.remove(path, {
            recursive: false,
            ...(request?.signal === undefined ? {} : { signal: request.signal }),
          }),
      ),
    openReadStream: (path, request) => translated("read", path, () => client.get(path, request)),
  };
  return defineFileDriver(backend, {
    name: client.name,
    ownership: "borrowed",
    getMetrics: () => client.getMetrics(),
    requirements: [{ code: "webhdfs-liststatus-batch", state: "unknown" }],
    limits: [{ code: "buffered-read-bytes", kind: "policy", source: "user", unit: "bytes", value: maximum }],
  });
}

/** Creates an import-safe native client and the conservative projection. */
export function createWebhdfsDriver(options: WebhdfsDriverOptionsType): FileDriverType {
  return createWebhdfsDriverFromClient(createWebhdfsClient(options), options);
}
