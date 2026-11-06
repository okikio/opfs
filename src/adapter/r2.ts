import { R2Error } from "../r2.ts";
import type { R2ClientType } from "../r2.ts";
import { createR2DriverFromClient } from "../driver/r2.ts";
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
export type R2AdapterOptionsType = ObjectAdapterOptionsType;

/** Binding categories belong to filesystem translation; the native client retains R2 failures. */
function failure(reason: unknown, operation: string, path: PathType): unknown {
  const primary = getPrimary(reason)?.reason ?? reason;
  if (!(primary instanceof R2Error)) return reason;
  return new FileSystemError(primary.code, operation, path, `R2 ${operation} failed: ${primary.code}.`, reason);
}

/** Retain original publication and cleanup causes rather than replacing them with a status guess. */
async function translated<Value>(operation: string, path: PathType, action: () => Promise<Value>): Promise<Value> {
  try {
    return await action();
  } catch (reason) {
    throw failure(reason, operation, path);
  }
}

/** Projects a borrowed R2 client through its driver and the generic object adapter. */
export function createR2Adapter(client: R2ClientType, options: R2AdapterOptionsType = {}): AdapterType {
  const adapter = createObjectAdapter(createR2DriverFromClient(client), options);
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
