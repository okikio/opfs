import { B2Error } from "../b2.ts";
import type { B2ClientType } from "../b2.ts";
import { createB2DriverFromClient } from "../driver/b2.ts";
import type { DriverPlanInputType } from "../driver/definition.ts";
import type {
  FileDriverCopyOptionsType,
  FileDriverReadOptionsType,
  FileDriverWriteOptionsType,
} from "../driver/file.ts";
import { getPrimary } from "../close.ts";
import { FileSystemError } from "../error.ts";
import type { PathType } from "../path.ts";
import type { AdapterType } from "./definition.ts";
import { createObjectAdapter } from "./object.ts";
import type { ObjectAdapterOptionsType } from "./object.ts";

/** Object-key filesystem projection options; cloud mechanics remain in the client. */
export type B2AdapterOptionsType = ObjectAdapterOptionsType;

/** HTTP categories belong to filesystem translation; the native client retains B2 failures. */
function failure(reason: unknown, operation: string, path: PathType): unknown {
  const primary = getPrimary(reason)?.reason ?? reason;
  if (!(primary instanceof B2Error)) return reason;
  const status = primary.status;
  const code = status === 404 || primary.code === "file_not_present"
    ? "not-found"
    : status === 401 || status === 403
    ? "permission-denied"
    : status === 409 || status === 412
    ? "locked"
    : status === 429
    ? "quota-exceeded"
    : status === 400
    ? "invalid-operation"
    : status >= 500
    ? "unavailable"
    : "unknown";
  return new FileSystemError(code, operation, path, `B2 ${operation} failed with HTTP ${status}.`, reason);
}

/** Retain original publication and cleanup causes rather than replacing them with a status guess. */
async function translated<Value>(operation: string, path: PathType, action: () => Promise<Value>): Promise<Value> {
  try {
    return await action();
  } catch (reason) {
    throw failure(reason, operation, path);
  }
}

/** Projects a borrowed B2 client through its driver and the generic object adapter. */
export function createB2Adapter(client: B2ClientType, options: B2AdapterOptionsType = {}): AdapterType {
  const adapter = createObjectAdapter(createB2DriverFromClient(client), options);
  return {
    name: adapter.name,
    driver: adapter.driver,
    capabilities: adapter.capabilities,
    ...(adapter.limits === undefined ? {} : { limits: adapter.limits }),
    ...(adapter.publication === undefined ? {} : { publication: adapter.publication }),
    ...(adapter.plan === undefined ? {} : { plan: (input: DriverPlanInputType) => adapter.plan!(input) }),
    stat: (path, request) => translated("stat", path, () => adapter.stat(path, request)),
    readFile: (path, request) => translated("read", path, () => adapter.readFile(path, request)),
    writeFile: (path, data, request) => translated("write", path, () => adapter.writeFile(path, data, request)),
    async *readDir(path, request) {
      try {
        yield* adapter.readDir(path, request);
      } catch (reason) {
        throw failure(reason, "list", path);
      }
    },
    createDir: (path, request) => translated("mkdir", path, () => adapter.createDir(path, request)),
    remove: (path, request) => translated("remove", path, () => adapter.remove(path, request)),
    ...(adapter.openReadStream === undefined ? {} : {
      openReadStream: (path: PathType, request?: FileDriverReadOptionsType) =>
        translated("read", path, () => adapter.openReadStream!(path, request)),
    }),
    ...(adapter.writeStream === undefined ? {} : {
      writeStream: (path: PathType, source: ReadableStream<Uint8Array>, request: FileDriverWriteOptionsType) =>
        translated("write", path, () => adapter.writeStream!(path, source, request)),
    }),
    ...(adapter.copy === undefined ? {} : {
      copy: (source: PathType, destination: PathType, request: FileDriverCopyOptionsType) =>
        translated("copy", destination, () => adapter.copy!(source, destination, request)),
    }),
    ...(adapter.dispose === undefined ? {} : { dispose: () => adapter.dispose!() }),
  };
}
