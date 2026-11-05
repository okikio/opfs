/** File projection of one native WebDAV collection; unprotected read-modify-write is refused. @module */
import { createWebdavClient, WebdavError } from "../webdav.ts";
import type { WebdavClientOptionsType, WebdavClientType } from "../webdav.ts";
import { defineFileDriver } from "./file.ts";
import type { FileBackendType, FileDriverType } from "./file.ts";
import type { DriverPlanInputType, DriverPlanType } from "./definition.ts";
import { basename } from "../path.ts";
import type { PathType } from "../path.ts";
import { range } from "../range.ts";
import { FileSystemError } from "../error.ts";
import { getPrimary } from "../close.ts";

/** Bounded materialization belongs to the file projection, not the protocol's streaming GET. */
export interface WebdavDriverOptionsType extends WebdavClientOptionsType {
  readonly maxReadBytes?: number;
}
export interface WebdavProjectionOptionsType {
  readonly maxReadBytes?: number;
}

/** Known HTTP categories preserve both native failures and independent response cleanup causes. */
async function translated<Value>(operation: string, path: PathType, action: () => Promise<Value>): Promise<Value> {
  try {
    return await action();
  } catch (reason) {
    const primary = getPrimary(reason)?.reason ?? reason;
    if (!(primary instanceof WebdavError)) throw reason;
    const status = primary.status;
    const code = status === 404
      ? "not-found"
      : status === 401 || status === 403
      ? "permission-denied"
      : status === 409 || status === 412 || status === 423
      ? "locked"
      : status === 507 || status === 429
      ? "quota-exceeded"
      : status >= 500
      ? "unavailable"
      : status === 405 || status === 501
      ? "not-supported"
      : "unknown";
    throw new FileSystemError(code, operation, path, `WebDAV ${operation} failed with HTTP ${status}.`, reason);
  }
}

/** The facade must refuse unsupported input routes before acquiring metadata or consuming a source. */
function admission(input: DriverPlanInputType): DriverPlanType {
  const refused = input.operation === "remove" || (input.operation === "write" &&
    (input.source === "stream" || (input.mode !== undefined && input.mode !== "replace"))) ||
    ((input.operation === "copy" || input.operation === "move") &&
      (input.preserve !== false || input.exclusive === true));
  return {
    operation: input.operation,
    supported: !refused,
    support: refused ? "unsupported" : "native",
    problems: refused
      ? [{
        code: "webdav-publication",
        layer: "driver",
        severity: "error",
        message:
          "WebDAV admits materialized replacement and explicit best-effort copy/move only; append, update, streamed writes, canonical removal and exclusive publication are unsupported.",
      }]
      : [],
    actions: refused ? [{ kind: "select-driver" }] : [],
  };
}

/** A borrowed client remains useful after this driver or its facade is closed. */
export function createWebdavDriverFromClient(
  client: WebdavClientType,
  options: WebdavProjectionOptionsType = {},
): FileDriverType {
  const maximum = options.maxReadBytes ?? 8 * 1024 * 1024;
  if (!Number.isSafeInteger(maximum) || maximum < 1) {
    throw new RangeError("maxReadBytes must be a positive safe integer.");
  }
  const backend: FileBackendType = {
    name: client.name,
    capabilities: {
      read: true,
      write: true,
      streamRead: true,
      streamWriteModes: [],
      rangeRead: true,
      copy: true,
      move: true,
      positionalWrite: false,
      syncAccess: false,
    },
    publication: {
      copy: "best-effort",
      move: "best-effort",
      noReplace: "cooperative",
      durability: "acknowledged",
    },
    admit: admission,
    stat: (path, request) =>
      translated("stat", path, async () => {
        const entry = await client.stat(path, request);
        if (entry === null) return null;
        return entry.kind === "directory"
          ? { kind: "directory", ...(entry.lastModified === undefined ? {} : { lastModified: entry.lastModified }) }
          : {
            kind: "file",
            size: entry.size!,
            lastModified: entry.lastModified ?? 0,
            mediaType: entry.mediaType ?? "",
          };
      }),
    readFile: (path, request = {}) =>
      translated("read", path, async () => {
        const selected = range(request);
        if (selected.empty) return new Uint8Array();
        const source = await client.openSource(path, {
          maxReadBytes: maximum,
          ...(selected.signal === undefined ? {} : { signal: selected.signal }),
        });
        const at = selected.start;
        const length = at >= source.size
          ? 0
          : Math.min(selected.end === undefined ? source.size - at : selected.end - at + 1, source.size - at);
        if (length > maximum) {
          throw new RangeError("WebDAV readFile exceeds maxReadBytes; use a stream or bounded range.");
        }
        return at >= source.size
          ? new Uint8Array()
          : await source.read(at, length, selected.signal === undefined ? {} : { signal: selected.signal });
      }),
    writeFile: async (path, data, request) => {
      if (request.mode !== "replace") {
        throw new FileSystemError("not-supported", "write", path, "WebDAV only admits replacement writes.");
      }
      await translated(
        "write",
        path,
        () =>
          client.put(path, data, {
            ...(request.signal === undefined ? {} : { signal: request.signal }),
            ...(request.mediaType === undefined ? {} : { mediaType: request.mediaType }),
          }),
      );
    },
    async *readDir(path, request) {
      const entries = await translated("list", path, () => client.list(path, request));
      for (const entry of entries) yield { name: basename(entry.path), kind: entry.kind };
    },
    createDir: (path, request) => translated("mkdir", path, () => client.mkdir(path, request)),
    // HTTP validators do not bind DAV resource kind. Even a checked file can
    // become a collection before recursive DELETE, so no one-entry removal is admitted.
    remove: (path) => {
      throw new FileSystemError(
        "not-supported",
        "remove",
        path,
        "WebDAV DELETE is recursive and cannot implement a safe one-entry removal.",
      );
    },
    openReadStream: (path, request) => translated("read", path, () => client.get(path, request)),
    copy: (source, destination, request) => {
      if (request.preserve !== false || request.exclusive) {
        throw new FileSystemError(
          "not-supported",
          "copy",
          destination,
          "WebDAV COPY requires explicit best-effort publication.",
        );
      }
      return translated(
        "copy",
        destination,
        () =>
          client.copy(source, destination, {
            overwrite: request.overwrite,
            ...(request.signal === undefined ? {} : { signal: request.signal }),
          }),
      );
    },
    move: (source, destination, request) => {
      if (request.preserve !== false || request.exclusive) {
        throw new FileSystemError(
          "not-supported",
          "move",
          destination,
          "WebDAV MOVE requires explicit best-effort publication.",
        );
      }
      return translated(
        "move",
        destination,
        () =>
          client.move(source, destination, {
            overwrite: request.overwrite,
            ...(request.signal === undefined ? {} : { signal: request.signal }),
          }),
      );
    },
  };
  return defineFileDriver(backend, {
    name: client.name,
    ownership: "borrowed",
    getMetrics: () => client.getMetrics(),
    limits: [{ code: "read-bytes", kind: "policy", source: "user", unit: "bytes", value: maximum }],
  });
}

/** Creates a client and a regular file projection without probing the server. */
export function createWebdavDriver(options: WebdavDriverOptionsType): FileDriverType {
  return createWebdavDriverFromClient(createWebdavClient(options), options);
}
